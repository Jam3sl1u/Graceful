import { z } from "zod";

export const USER_ROLE_VALUES = ["admin", "set_leader", "member", "guest"] as const;

export const updateRoleSchema = z.object({
  role: z.enum(USER_ROLE_VALUES),
});

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
