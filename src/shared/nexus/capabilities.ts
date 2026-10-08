// Capabilities an agent token can be granted (tokens arrive in B2b). A domain's
// spec lists its ceiling; nothing in B2a grants any of them. `availableFrom: null`
// means not planned in B2–B6. Host execution is never a capability.

import type { CapabilityId, SkillId, SubPhase } from './domainSpec';
import { deepFreeze } from './freeze';

export interface CapabilityDef { id: CapabilityId; label: string; availableFrom: SubPhase | null }

export const CAPABILITIES: readonly CapabilityDef[] = deepFreeze([
  { id: 'code.read', label: 'Read code', availableFrom: 'B2b' },
  { id: 'code.edit', label: 'Edit code within a path scope', availableFrom: 'B2b' },
  { id: 'git.commit', label: 'Commit on a job branch', availableFrom: 'B2b' },
  { id: 'sandbox.exec', label: 'Run commands in its own container', availableFrom: 'B2b' },
  { id: 'artifact.read', label: 'Read artifacts', availableFrom: 'B2b' },
  { id: 'artifact.register', label: 'Register its own artifacts', availableFrom: 'B2b' },
  { id: 'job.request', label: 'Request recipe jobs', availableFrom: 'B2b' },
  { id: 'handoff.create', label: 'Send handoffs', availableFrom: 'B2c' },
  { id: 'review.request', label: 'Request a review', availableFrom: 'B2b' },
  { id: 'approval.request', label: 'Request an approval for network access', availableFrom: 'B2b' },
  { id: 'test.run', label: 'Run tests', availableFrom: 'B2b' },
  { id: 'test.author', label: 'Write tests', availableFrom: 'B2c' },
  { id: 'defect.propose', label: 'Propose defects', availableFrom: 'B2c' },
  { id: 'build.request', label: 'Request builds', availableFrom: 'B2b' },
  { id: 'preview.request', label: 'Request dev deployments', availableFrom: 'B2b' },
  { id: 'data.read', label: 'Read datasets', availableFrom: 'B3' },
  { id: 'data.register', label: 'Register datasets', availableFrom: 'B3' },
  { id: 'sql.query', label: 'Run read-only queries', availableFrom: 'B3' },
  { id: 'notebook.run', label: 'Run notebooks', availableFrom: 'B4' },
  { id: 'stats.run', label: 'Run statistics', availableFrom: 'B4' },
  { id: 'model.train.cpu', label: 'Train models on the CPU', availableFrom: 'B4' },
  { id: 'model.evaluate', label: 'Evaluate models', availableFrom: 'B4' },
  { id: 'model.package', label: 'Package models', availableFrom: 'B5' },
  { id: 'model.serve', label: 'Serve models locally', availableFrom: 'B5' },
  { id: 'model.export', label: 'Export models', availableFrom: 'B6' },
  { id: 'model.optimize', label: 'Optimize model exports', availableFrom: 'B6' },
  { id: 'gpu.train', label: 'Train on a GPU', availableFrom: null },
  { id: 'connector.read', label: 'Read external data connectors', availableFrom: null }
]);

export const CAPABILITY_IDS: readonly CapabilityId[] = deepFreeze(CAPABILITIES.map((c) => c.id));

/** Agent skills arrive in B2b; none is registered in B2a, so no spec can name one. */
export interface SkillDef { id: SkillId; label: string; availableFrom: SubPhase }
export const SKILLS: readonly SkillDef[] = deepFreeze([]);
