import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const JsonSchema: z.ZodType<Json> = z.lazy(() => z.union([z.null(),z.boolean(),z.number().finite(),z.string().max(150000),z.array(JsonSchema).max(1000),z.record(z.string(),JsonSchema)]));
const id = z.string().min(1).max(160);
const version = z.union([z.string().min(1).max(100),z.number().int().positive()]);
const utc = z.string().datetime();
export const AttemptSchema = z.object({
  id: z.string().uuid(), taskId:id, taskVersion:version, sessionId:id,
  originalAnswer:JsonSchema, startedAt:utc, submittedAt:utc, hintCount:z.number().int().min(0).max(1000),
  assistance:z.array(z.string().max(300)).max(30), exposureGroupId:id, noveltyKind:z.enum(['familiar','unfamiliar']),
  parentAttemptId:z.string().uuid().nullable(), mentorText: z.object({id,version,sha256:z.string()}).strict().nullable(),
}).strict();
export type Attempt = z.infer<typeof AttemptSchema>;
export const JudgmentSchema = z.object({
  id:z.string().uuid(),attemptId:z.string().uuid(),judgeKind:z.enum(['authored_key','local_approved_proposal']),judgeVersion:id,
  rubricVersionId:z.string().nullable(),result:z.object({status:z.enum(['correct','incorrect','needs_review']),feedback:z.string(),provisional:z.boolean(),sourceChecked:z.boolean(),proposal:JsonSchema.optional()}).strict(),
  quotedEvidence:z.array(z.string()),uncertaintyReason:z.string().nullable(),supersedesId:z.string().uuid().nullable(),createdAt:utc,
}).strict();
export type Judgment=z.infer<typeof JudgmentSchema>;
export const EvidenceSchema=z.object({id:z.string().uuid(),attemptId:z.string().uuid(),judgmentId:z.string().uuid(),skillId:id,
  evidenceKind:z.enum(['success','failure','pending']),independence:z.enum(['unaided','assisted']),eligible:z.boolean(),exclusionReason:z.string().nullable(),createdAt:utc,
  familyId:id,noveltyKind:z.enum(['familiar','unfamiliar']),sourceChecked:z.boolean(),hintCount:z.number().int().min(0),
  eligibilityPolicyVersion:z.literal(2).optional(),
  eligibilityContextAttemptIds:z.array(z.string().uuid()).max(10000).optional(),
}).strict().superRefine((event,ctx)=>{if((event.eligibilityPolicyVersion===2)!==(event.eligibilityContextAttemptIds!==undefined))ctx.addIssue({code:'custom',message:'Policy v2 evidence must include its recorded attempt context'});});
export type Evidence=z.infer<typeof EvidenceSchema>;
export const InterchangeSchema=z.object({schemaVersion:z.literal(1),appVersion:z.literal('0.1.0'),exportedAt:utc,origin:z.literal('sei-study-lab'),
  catalog:z.object({tasks:z.array(JsonSchema).max(2000),sources:z.array(JsonSchema).max(1000),mentorTexts:z.array(JsonSchema).max(500),rubrics:z.array(JsonSchema).max(500)}).strict(),
  attempts:z.array(AttemptSchema).max(10000),judgments:z.array(JudgmentSchema).max(20000),evidenceEvents:z.array(EvidenceSchema).max(30000),
}).strict();
export type Interchange=z.infer<typeof InterchangeSchema>;
export const SubmitSchema=z.object({taskId:id,taskVersion:version,answer:JsonSchema,hintCount:z.number().int().min(0).max(1000),assistance:z.array(z.string().max(300)).max(30).default([]),parentAttemptId:z.string().uuid().nullable().optional(),startedAt:utc.optional()}).strict();
