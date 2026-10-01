import type { OfficeCharacterName } from '../scene/office/cast';
import type { DomainId } from '@shared/domain';

export type StationKind =
  | 'primary_workstation'
  | 'secondary_station'
  | 'verification_station'
  | 'meeting_table'
  | 'mission_board'
  | 'coffee_lounge'
  | 'water_cooler'
  | 'social_junction';

export type BehaviorState =
  | 'working'
  | 'performing_activity'
  | 'verifying'
  | 'blocked'
  | 'celebrating'
  | 'walking_to_station'
  | 'social_chatting'
  | 'idle_resting';

export interface OfficeStation {
  id: string;
  name: string;
  kind: StationKind;
  x: number;
  y: number;
  facing: 'down' | 'up' | 'left' | 'right';
  domainId?: DomainId;
  defaultDurationSec: number;
  activities: string[];
  contextualThoughts: string[];
}

export interface DomainOfficeLayout {
  domainId: DomainId;
  character: OfficeCharacterName;
  displayName: string;
  roleTitle: string;
  primaryWorkstation: OfficeStation;
  secondaryStations: OfficeStation[];
  verificationStation: OfficeStation;
}

export interface SocialDialogue {
  pair: [OfficeCharacterName, OfficeCharacterName];
  stationId: string;
  speaker1Line: string;
  speaker2Line: string;
  durationSec: number;
}
