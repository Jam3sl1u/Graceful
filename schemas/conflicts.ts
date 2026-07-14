import { z } from "zod";

// POST /api/conflicts/:id/resolve body (#47). Three manual resolution paths;
// AI replacement suggestions (Phase 4) are explicitly out of scope.
export const resolveConflictSchema = z.object({
  resolution: z.enum(["withdraw", "member_reconfirmed", "admin_dismissed"]),
});
export type ResolveConflictInput = z.infer<typeof resolveConflictSchema>;
