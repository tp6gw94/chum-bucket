import { z } from "zod";

export const sideChatPath = "/api/side-chat";

export const sideChatSchema = z.object({
  id: z.uuid(),
  parentThreadId: z.uuid(),
  title: z.string(),
  revision: z.number().int().nonnegative(),
});

export const sideChatListSchema = z.array(sideChatSchema);

export const createSideChatSchema = z.strictObject({ parentThreadId: z.uuid() });

export type SideChat = z.infer<typeof sideChatSchema>;
