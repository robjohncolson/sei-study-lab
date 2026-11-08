import type { Catalog as SharedCatalog } from '../../../packages/shared/src/index';
export type Catalog = SharedCatalog;
export type Task = Catalog['tasks'][number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type EventRow = { id: string; taskId?: string; taskVersion?: string|number; attemptId?: string; skillId?: string; submittedAt?: string; createdAt?: string; originalAnswer?: JsonValue; answer?: JsonValue; hintCount?: number; result?: JsonValue; resultJson?: JsonValue; eligible?: boolean; exclusionReason?: string|null; [key:string]: unknown };
export type Readiness = { skillId?: string; status: string; explanation?: string; reason?: string; eligibleCount?: number; observedCount?: number; historicalVersionCount?: number; exclusions?: {attemptId:string;reason:string}[]; familyCount?: number; dates?: string[]; [key:string]: unknown };
export type StudyState = { attempts: EventRow[]; judgments: EventRow[]; evidenceEvents: EventRow[]; taskVersions?: Task[]; readiness?: Record<string, Readiness> | Readiness[] };
