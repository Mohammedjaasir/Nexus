import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  completeNexusCloudConnectorEnrollment,
  loadNexusCloudConnectorIdentity,
  nexusCloudConnectorEnrollmentStatus,
  nexusCloudConnectorIdentityPath,
  startNexusCloudConnectorEnrollment,
} from "./nexus-cloud-connector-enrollment.js";
import { nexusCloudConnectorConfigFromEnv } from "./nexus-cloud-connector.js";
import { reconcileNexusCloudConnectorEnrollmentStatus } from "./nexus-cloud-connector-status.js";

describe("Nexus Cloud self-host enrollment", () => {
  let root = "";
  let previousHome: string | undefined;
  let previousInstance: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "nexus-cloud-connector-"));
    previousHome = process.env.NEXUS_HOME;
    previousInstance = process.env.NEXUS_INSTANCE_ID;
    process.env.NEXUS_HOME = root;
    process.env.NEXUS_INSTANCE_ID = "connector-test";
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.NEXUS_HOME;
    else process.env.NEXUS_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.NEXUS_INSTANCE_ID;
    else process.env.NEXUS_INSTANCE_ID = previousInstance;
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps private keys owner-only and activates only the matching one-time callback", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/v1/connector/enrollments")) {
        return Response.json({
          enrollmentId: "enroll-test",
          verificationUrl: "https://my.example.test/connections/enroll?id=enroll-test",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }, { status: 201 });
      }
      const token = String(body.request);
      const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(claims).toMatchObject({
        iss: loadNexusCloudConnectorIdentity()?.instanceId,
        aud: "https://my.example.test/v1/connector/enrollment-claims",
        env: "development",
        op: "enroll",
      });
      expect(typeof claims.ah).toBe("string");
      return Response.json({
        id: loadNexusCloudConnectorIdentity()?.instanceId,
        environment: "development",
        origins: ["https://private.example.test"],
      });
    });

    const pending = await startNexusCloudConnectorEnrollment({
      origin: "https://private.example.test",
      env: {
        NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my.example.test",
        NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: "development",
      },
      request: request as typeof fetch,
    });
    expect(pending.status).toBe("pending");
    expect(pending.verificationUrl).toBe("https://my.example.test/connections/enroll?id=enroll-test");
    expect(statSync(path.dirname(nexusCloudConnectorIdentityPath())).mode & 0o777).toBe(0o700);
    expect(statSync(nexusCloudConnectorIdentityPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(nexusCloudConnectorIdentityPath(), "utf8")).not.toContain("approval-code");

    await expect(completeNexusCloudConnectorEnrollment({
      enrollmentId: "enroll-test",
      approvalCode: "approval-code",
      state: "wrong-state",
      request: request as typeof fetch,
    })).rejects.toThrow(/Invalid or expired/);

    const state = loadNexusCloudConnectorIdentity()?.pending?.returnState;
    const active = await completeNexusCloudConnectorEnrollment({
      enrollmentId: "enroll-test",
      approvalCode: "approval-code",
      state: state!,
      request: request as typeof fetch,
    });
    expect(active).toMatchObject({ configured: true, status: "active", origins: ["https://private.example.test"] });
    const config = nexusCloudConnectorConfigFromEnv({});
    expect(config).toMatchObject({ baseUrl: "https://my.example.test", environment: "development" });
    expect(requests).toHaveLength(2);

    const statusRequest = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://my.example.test/v1/connector/instance-status");
      return Response.json({ active: false, status: "suspended" });
    });
    await expect(reconcileNexusCloudConnectorEnrollmentStatus({}, statusRequest as typeof fetch)).resolves.toMatchObject({
      configured: false,
      status: "suspended",
      instanceId: active.instanceId,
    });
  });

  it("rejects non-loopback plain HTTP destinations before creating keys", async () => {
    await expect(startNexusCloudConnectorEnrollment({
      origin: "http://private.example.test",
      request: vi.fn() as typeof fetch,
    })).rejects.toThrow(/requires HTTPS/);
    expect(nexusCloudConnectorEnrollmentStatus().status).toBe("not_configured");
  });

  it.each([
    "https://my.example.test/connections/enroll?id=another-enrollment",
    "https://my.example.test/connections/enroll",
    "https://my.example.test/connections/enroll?id=enroll-test&next=%2Faccount",
    "https://my.example.test/connections/enroll?id=enroll-test#fragment",
    "https://user@my.example.test/connections/enroll?id=enroll-test",
  ])("rejects an imprecise broker verification destination: %s", async (verificationUrl) => {
    await expect(startNexusCloudConnectorEnrollment({
      origin: "https://private.example.test",
      env: {
        NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my.example.test",
        NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: "development",
      },
      request: vi.fn(async () => Response.json({
        enrollmentId: "enroll-test",
        verificationUrl,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, { status: 201 })) as typeof fetch,
    })).rejects.toThrow(/invalid enrollment destination/);
  });

  it("serializes overlapping starts and reuses one unexpired enrollment", async () => {
    let releaseBroker!: () => void;
    const brokerMayRespond = new Promise<void>((resolve) => {
      releaseBroker = resolve;
    });
    const request = vi.fn(async () => {
      await brokerMayRespond;
      return Response.json({
        enrollmentId: "enroll-shared",
        verificationUrl: "https://my.example.test/connections/enroll?id=enroll-shared",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, { status: 201 });
    });
    const values = {
      origin: "https://private.example.test",
      companyId: "company-test",
      initiatedBy: "user:admin-test",
      env: {
        NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my.example.test",
        NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: "development",
      },
      request: request as typeof fetch,
    };

    const first = startNexusCloudConnectorEnrollment(values);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const second = startNexusCloudConnectorEnrollment(values);
    releaseBroker();

    const [firstStatus, secondStatus] = await Promise.all([first, second]);
    expect(request).toHaveBeenCalledOnce();
    expect(firstStatus).toMatchObject({ status: "pending", verificationUrl: expect.stringContaining("enroll-shared") });
    expect(secondStatus).toEqual(firstStatus);
    expect(loadNexusCloudConnectorIdentity()?.pending).toMatchObject({
      enrollmentId: "enroll-shared",
      companyId: "company-test",
      initiatedBy: "user:admin-test",
    });
    await expect(startNexusCloudConnectorEnrollment({
      ...values,
      initiatedBy: "user:another-admin",
    })).rejects.toThrow(/another administrator/);
    await expect(startNexusCloudConnectorEnrollment({
      ...values,
      companyId: "another-company",
    })).rejects.toThrow(/another company/);
    expect(request).toHaveBeenCalledOnce();
  });

  it("defaults an enrollment to the environment of the standard Cloud broker", () => {
    expect(nexusCloudConnectorEnrollmentStatus({})).toMatchObject({
      brokerBaseUrl: "https://my.paperclip.app",
      environment: "production",
    });
    expect(nexusCloudConnectorEnrollmentStatus({
      NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
    })).toMatchObject({ environment: "staging" });
    expect(nexusCloudConnectorEnrollmentStatus({
      NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://test.paperclip.app",
    })).toMatchObject({ environment: "test" });
  });

  it.each(["development", "staging", "production"])("rejects %s identity at the test broker", (environment) => {
    expect(() => nexusCloudConnectorEnrollmentStatus({
      NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://test.paperclip.app",
      NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: environment,
    })).toThrow(/broker and environment do not match/);
  });

  it("persists test enrollment identity and signs requests for the test broker", async () => {
    const origin = "https://tenant.test.paperclip.app";
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith("/enrollments")) {
        expect(body).toMatchObject({ environment: "test", origin });
        return Response.json({ enrollmentId: "enroll-test", verificationUrl: "https://test.paperclip.app/connections/enroll?id=enroll-test", expiresAt: new Date(Date.now() + 60_000).toISOString() }, { status: 201 });
      }
      const claims = JSON.parse(Buffer.from(body.request.split(".")[1], "base64url").toString("utf8"));
      expect(claims).toMatchObject({ env: "test", aud: "https://test.paperclip.app/v1/connector/enrollment-claims" });
      return Response.json({ id: loadNexusCloudConnectorIdentity()!.instanceId, environment: "test", origins: [origin] });
    });
    const env = { NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://test.paperclip.app" };
    await startNexusCloudConnectorEnrollment({ origin, env, request: request as typeof fetch });
    const pending = loadNexusCloudConnectorIdentity()!;
    await completeNexusCloudConnectorEnrollment({ enrollmentId: "enroll-test", approvalCode: "approval-code", state: pending.pending!.returnState, env, request: request as typeof fetch });
    expect(nexusCloudConnectorConfigFromEnv(env)).toMatchObject({ environment: "test", baseUrl: "https://test.paperclip.app", instanceId: pending.instanceId });
  });

  it("rotates a non-active identity instead of mixing enrollment targets", async () => {
    const origin = "https://private.example.test";
    const productionRequest = vi.fn(async () => Response.json({
      enrollmentId: "enroll-production",
      verificationUrl: "https://my.paperclip.app/connections/enroll?id=enroll-production",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, { status: 201 }));
    await startNexusCloudConnectorEnrollment({
      origin,
      env: { NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my.paperclip.app" },
      request: productionRequest as typeof fetch,
    });
    const productionIdentity = loadNexusCloudConnectorIdentity()!;

    expect(nexusCloudConnectorEnrollmentStatus({
      NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
    })).toEqual({
      configured: false,
      status: "unverified",
      brokerBaseUrl: "https://my-staging.paperclip.app",
      instanceId: null,
      environment: "staging",
      origins: [],
    });

    const stagingRequest = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://my-staging.paperclip.app/v1/connector/enrollments");
      expect(JSON.parse(String(init?.body))).toMatchObject({ environment: "staging", origin });
      return Response.json({
        enrollmentId: "enroll-staging",
        verificationUrl: "https://my-staging.paperclip.app/connections/enroll?id=enroll-staging",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, { status: 201 });
    });
    const stagingStatus = await startNexusCloudConnectorEnrollment({
      origin,
      env: { NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app" },
      request: stagingRequest as typeof fetch,
    });
    const stagingIdentity = loadNexusCloudConnectorIdentity()!;

    expect(stagingStatus).toMatchObject({
      status: "pending",
      brokerBaseUrl: "https://my-staging.paperclip.app",
      environment: "staging",
      verificationUrl: "https://my-staging.paperclip.app/connections/enroll?id=enroll-staging",
    });
    expect(stagingIdentity.instanceId).not.toBe(productionIdentity.instanceId);
    expect(stagingIdentity.signPublicKey).not.toBe(productionIdentity.signPublicKey);
    expect(stagingIdentity.sealPublicKey).not.toBe(productionIdentity.sealPublicKey);
    expect(stagingRequest).toHaveBeenCalledOnce();
  });

  it("fails closed when the configured target changes during callback or after activation", async () => {
    const origin = "https://private.example.test";
    const productionEnv = {
      NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my.paperclip.app",
      NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: "production",
    };
    const request = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/connector/enrollments")) {
        return Response.json({
          enrollmentId: "enroll-production",
          verificationUrl: "https://my.paperclip.app/connections/enroll?id=enroll-production",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }, { status: 201 });
      }
      return Response.json({
        id: loadNexusCloudConnectorIdentity()?.instanceId,
        environment: "production",
        origins: [origin],
      });
    });
    await startNexusCloudConnectorEnrollment({ origin, env: productionEnv, request: request as typeof fetch });
    const pending = loadNexusCloudConnectorIdentity()!;
    const changedTargetRequest = vi.fn();

    await expect(completeNexusCloudConnectorEnrollment({
      enrollmentId: "enroll-production",
      approvalCode: "approval-code",
      state: pending.pending!.returnState,
      env: {
        NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
        NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
      },
      request: changedTargetRequest as typeof fetch,
    })).rejects.toThrow(/Invalid or expired/);
    expect(changedTargetRequest).not.toHaveBeenCalled();

    await completeNexusCloudConnectorEnrollment({
      enrollmentId: "enroll-production",
      approvalCode: "approval-code",
      state: pending.pending!.returnState,
      env: productionEnv,
      request: request as typeof fetch,
    });
    const activeIdentity = loadNexusCloudConnectorIdentity()!;
    const activeSwitchRequest = vi.fn();
    const stagingEnv = {
      NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
      NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
    };

    await expect(startNexusCloudConnectorEnrollment({
      origin,
      env: stagingEnv,
      request: activeSwitchRequest as typeof fetch,
    })).rejects.toThrow(/another target/);
    expect(activeSwitchRequest).not.toHaveBeenCalled();
    expect(loadNexusCloudConnectorIdentity()).toEqual(activeIdentity);
    expect(nexusCloudConnectorConfigFromEnv(stagingEnv)).toBeNull();
  });

  it("treats managed environment identity as an atomic override of local identity", async () => {
    const origin = "https://private.example.test";
    const productionEnv = {
      NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my.paperclip.app",
      NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: "production",
    };
    const request = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/connector/enrollments")) {
        return Response.json({
          enrollmentId: "enroll-production",
          verificationUrl: "https://my.paperclip.app/connections/enroll?id=enroll-production",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }, { status: 201 });
      }
      return Response.json({
        id: loadNexusCloudConnectorIdentity()?.instanceId,
        environment: "production",
        origins: [origin],
      });
    });
    await startNexusCloudConnectorEnrollment({ origin, env: productionEnv, request: request as typeof fetch });
    const pending = loadNexusCloudConnectorIdentity()!;
    await completeNexusCloudConnectorEnrollment({
      enrollmentId: "enroll-production",
      approvalCode: "approval-code",
      state: pending.pending!.returnState,
      env: productionEnv,
      request: request as typeof fetch,
    });
    const localIdentity = loadNexusCloudConnectorIdentity()!;

    const managedEnv = {
      NEXUS_CLOUD_CONNECTOR_INSTANCE_ID: "managed-staging-instance",
      NEXUS_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: "managed-signing-key",
      NEXUS_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY: "managed-sealing-key",
      NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
      NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
      NEXUS_PUBLIC_URL: "https://managed-stack.example.test",
    };
    expect(nexusCloudConnectorEnrollmentStatus(managedEnv)).toEqual({
      configured: true,
      status: "active",
      brokerBaseUrl: "https://my-staging.paperclip.app",
      instanceId: "managed-staging-instance",
      environment: "staging",
      origins: ["https://managed-stack.example.test"],
    });
    expect(nexusCloudConnectorConfigFromEnv(managedEnv)).toMatchObject({
      baseUrl: "https://my-staging.paperclip.app",
      instanceId: "managed-staging-instance",
      environment: "staging",
      signPrivateKey: "managed-signing-key",
      sealPrivateKey: "managed-sealing-key",
    });
    expect(loadNexusCloudConnectorIdentity()).toEqual(localIdentity);

    for (const omitted of [
      "NEXUS_CLOUD_CONNECTOR_INSTANCE_ID",
      "NEXUS_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY",
      "NEXUS_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY",
      "NEXUS_CLOUD_CONNECTOR_ENVIRONMENT",
    ] as const) {
      const partialManagedEnv: NodeJS.ProcessEnv = { ...managedEnv };
      delete partialManagedEnv[omitted];
      expect(nexusCloudConnectorEnrollmentStatus(partialManagedEnv)).toMatchObject({
        configured: false,
        status: "unverified",
        instanceId: null,
        environment: "staging",
      });
      expect(() => nexusCloudConnectorConfigFromEnv(partialManagedEnv)).toThrow(/incomplete/);
      expect(loadNexusCloudConnectorIdentity()).toEqual(localIdentity);
    }

    expect(nexusCloudConnectorConfigFromEnv(productionEnv)).toMatchObject({
      baseUrl: localIdentity.brokerBaseUrl,
      instanceId: localIdentity.instanceId,
      environment: localIdentity.environment,
      signPrivateKey: localIdentity.signPrivateKey,
      sealPrivateKey: localIdentity.sealPrivateKey,
    });
  });

  it("rejects known Cloud broker and environment mismatches", () => {
    const managedIdentity = {
      NEXUS_CLOUD_CONNECTOR_INSTANCE_ID: "managed-instance",
      NEXUS_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: "managed-signing-key",
      NEXUS_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY: "managed-sealing-key",
    };
    const mismatches = [
      {
        ...managedIdentity,
        NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my.paperclip.app",
        NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
      },
      {
        ...managedIdentity,
        NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
        NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: "production",
      },
    ];
    for (const env of mismatches) {
      expect(() => nexusCloudConnectorEnrollmentStatus(env)).toThrow(/do not match/);
      expect(() => nexusCloudConnectorConfigFromEnv(env)).toThrow(/do not match/);
    }
    expect(() => nexusCloudConnectorEnrollmentStatus({
      NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
    })).toThrow(/do not match/);
  });

  it("does not create or complete self-host enrollment with managed identity configuration", async () => {
    const origin = "https://private.example.test";
    const localEnv = {
      NEXUS_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
      NEXUS_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
    };
    const enrollmentRequest = vi.fn(async () => Response.json({
      enrollmentId: "enroll-local",
      verificationUrl: "https://my-staging.paperclip.app/connections/enroll?id=enroll-local",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, { status: 201 }));
    await startNexusCloudConnectorEnrollment({
      origin,
      env: localEnv,
      request: enrollmentRequest as typeof fetch,
    });
    const pendingIdentity = loadNexusCloudConnectorIdentity()!;
    const managedEnv = {
      ...localEnv,
      NEXUS_CLOUD_CONNECTOR_INSTANCE_ID: "managed-staging-instance",
      NEXUS_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: "managed-signing-key",
      NEXUS_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY: "managed-sealing-key",
    };
    const managedRequest = vi.fn();

    await expect(startNexusCloudConnectorEnrollment({
      origin,
      env: managedEnv,
      request: managedRequest as typeof fetch,
    })).rejects.toThrow(/unavailable with managed identity/);
    await expect(completeNexusCloudConnectorEnrollment({
      enrollmentId: "enroll-local",
      approvalCode: "approval-code",
      state: pendingIdentity.pending!.returnState,
      env: managedEnv,
      request: managedRequest as typeof fetch,
    })).rejects.toThrow(/Invalid or expired/);
    expect(managedRequest).not.toHaveBeenCalled();
    expect(loadNexusCloudConnectorIdentity()).toEqual(pendingIdentity);
  });

  it("does not treat legacy Nexus ID keys as a Cloud enrollment", () => {
    expect(nexusCloudConnectorEnrollmentStatus({
      NEXUS_ID_CONNECTOR_INSTANCE_ID: "legacy-instance",
      NEXUS_ID_CONNECTOR_SIGN_PRIVATE_KEY: "legacy-signing-key",
      NEXUS_ID_CONNECTOR_SEAL_PRIVATE_KEY: "legacy-sealing-key",
      NEXUS_ID_CONNECTOR_ENVIRONMENT: "production",
      NEXUS_ID_CONNECTOR_BASE_URL: "https://id.paperclip.app",
    })).toMatchObject({
      configured: false,
      status: "not_configured",
      brokerBaseUrl: "https://my.paperclip.app",
      instanceId: null,
    });
  });
});
