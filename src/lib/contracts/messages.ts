// @polsia:user-owned
import { z } from 'zod';

export const MessageProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(['fan', 'artist']),
});

export const MessageItemSchema = z.object({
  id: z.string().min(1),
  senderId: z.string().min(1),
  content: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const MessagePreviewSchema = z.object({
  content: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const MessageConversationSummarySchema = z.object({
  id: z.string().min(1),
  participant: MessageProfileSchema,
  lastMessage: MessagePreviewSchema,
});

export const MessagesInboxResponseSchema = z.object({
  conversations: z.array(MessageConversationSummarySchema),
});

export const MessageThreadResponseSchema = z.object({
  currentUserId: z.string().min(1),
  conversation: z.object({
    id: z.string().min(1),
    participant: MessageProfileSchema,
  }),
  messages: z.array(MessageItemSchema),
});

export const CreateConversationMessageSchema = z.object({
  profileId: z.string().min(1).max(64),
  content: z.string().trim().min(1).max(5000),
});

export const SendMessageSchema = z.object({
  content: z.string().trim().min(1).max(5000),
});

export const MessageMutationResponseSchema = z.object({
  conversationId: z.string().min(1),
  message: MessageItemSchema,
});

export type MessageProfile = z.infer<typeof MessageProfileSchema>;
export type MessageItem = z.infer<typeof MessageItemSchema>;
export type MessageConversationSummary = z.infer<typeof MessageConversationSummarySchema>;
