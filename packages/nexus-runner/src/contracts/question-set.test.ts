import Ajv2020 from "ajv/dist/2020.js";
import { questionSetSchema } from "../protocol/generated/schema-bundle.js";
import { describe, expect, it } from "vitest";

import {
  NEXUS_QUESTION_RESPONSE_SCHEMA,
  NEXUS_QUESTION_SET_SCHEMA,
  parseNexusQuestionResponse,
  parseNexusQuestionSet,
  type NexusQuestionSet,
} from "./question-set.js";

const questionSet: NexusQuestionSet = {
  schema: NEXUS_QUESTION_SET_SCHEMA,
  title: "Release input",
  questions: [
    {
      id: "environment",
      prompt: "Where should we deploy?",
      required: true,
      answerMode: "single_select",
      options: [
        { id: "staging", label: "Staging", recommended: true },
        { id: "production", label: "Production" },
      ],
      customAnswer: { enabled: true, label: "Other" },
    },
    {
      id: "replicas",
      prompt: "How many replicas?",
      required: true,
      answerMode: "text",
      textValidation: { inputType: "integer", minimum: 1, maximum: 20 },
    },
  ],
};

describe("Nexus question-set contract", () => {
  it("round-trips the portable presentation model", () => {
    expect(parseNexusQuestionSet(questionSet)).toEqual(questionSet);
    expect(parseNexusQuestionResponse(questionSet, {
      schema: NEXUS_QUESTION_RESPONSE_SCHEMA,
      answers: {
        environment: { selectedOptionIds: ["staging"] },
        replicas: { text: "3" },
      },
    })).toEqual({
      schema: NEXUS_QUESTION_RESPONSE_SCHEMA,
      answers: {
        environment: { selectedOptionIds: ["staging"] },
        replicas: { text: "3" },
      },
    });
  });

  it("preserves bounded initial text only as presentation, including empty text", () => {
    for (const initialText of ["", "  Draft\n漢字\n", "a".repeat(100_000)]) {
      const input = { schema: NEXUS_QUESTION_SET_SCHEMA, questions: [{ id: "draft", prompt: "Edit", required: true, answerMode: "text", initialText }] };
      expect(parseNexusQuestionSet(input)).toEqual(input);
      expect(() => parseNexusQuestionResponse(input, { schema: NEXUS_QUESTION_RESPONSE_SCHEMA, answers: {} })).toThrow(/required/);
    }
    for (const initialText of [null, 1, "a".repeat(100_001), "a".repeat(100_000) + "😀"]) {
      expect(() => parseNexusQuestionSet({ ...questionSet, questions: [{ ...questionSet.questions[1], initialText }] })).toThrow(/initialText/);
    }
    expect(() => parseNexusQuestionSet({ ...questionSet, questions: [{ ...questionSet.questions[0], initialText: "staging" }] })).toThrow(/only text/);
    const input = { ...questionSet, questions: [{ ...questionSet.questions[1], initialText: "21" }] };
    expect(() => parseNexusQuestionResponse(input, { schema: NEXUS_QUESTION_RESPONSE_SCHEMA, answers: { replicas: { text: "21" } } })).toThrow(/at most 20/);
  });

  it("matches the published Unicode code-point draft limit within the wire byte cap", () => {
    const validate = new Ajv2020({ strict: true, strictRequired: false }).compile(questionSetSchema);
    for (const codePoints of [100_000, 100_001]) {
      const initialText = "a".repeat(codePoints - 1) + "😀";
      const input = { schema: NEXUS_QUESTION_SET_SCHEMA, questions: [{ id: "draft", prompt: "Edit", required: true, answerMode: "text", initialText }] };
      expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(196 * 1024);
      expect(initialText.length).toBe(codePoints + 1);
      expect(validate(input)).toBe(codePoints === 100_000);
      if (codePoints === 100_000) {
        expect(parseNexusQuestionSet(input)).toEqual(input);
        expect(() => parseNexusQuestionResponse(input, { schema: NEXUS_QUESTION_RESPONSE_SCHEMA, answers: { draft: { text: initialText } } })).toThrow();
      } else {
        expect(() => parseNexusQuestionSet(input)).toThrow(/Unicode code points/);
      }
    }
  });

  it("rejects missing, unknown, and provider-shaped answers", () => {
    expect(() => parseNexusQuestionResponse(questionSet, {
      schema: NEXUS_QUESTION_RESPONSE_SCHEMA,
      answers: { environment: { selectedOptionIds: ["unknown"] }, replicas: { text: "3" } },
    })).toThrow(/unknown option/);
    expect(() => parseNexusQuestionResponse(questionSet, {
      schema: NEXUS_QUESTION_RESPONSE_SCHEMA,
      answers: { environment: { selectedOptionIds: ["staging"] } },
    })).toThrow(/replicas.*required/);
    expect(() => parseNexusQuestionResponse(questionSet, {
      answers: { environment: { answers: ["Staging"] } },
    })).toThrow(/nexus.question_response.v1/);
    expect(() => parseNexusQuestionResponse(questionSet, {
      schema: NEXUS_QUESTION_RESPONSE_SCHEMA,
      answers: {
        environment: { answers: ["Staging"] },
        replicas: { text: "3" },
      },
    })).toThrow(/canonical response contract/);
  });

  it("applies typed numeric validation before an adapter sees the answer", () => {
    expect(() => parseNexusQuestionResponse(questionSet, {
      schema: NEXUS_QUESTION_RESPONSE_SCHEMA,
      answers: {
        environment: { customText: "Canary" },
        replicas: { text: "3.5" },
      },
    })).toThrow(/valid integer/);
    expect(() => parseNexusQuestionResponse(questionSet, {
      schema: NEXUS_QUESTION_RESPONSE_SCHEMA,
      answers: {
        environment: { customText: "Canary" },
        replicas: { text: "21" },
      },
    })).toThrow(/at most 20/);
  });
});
