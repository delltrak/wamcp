import { z } from "zod";
import type { AuthenticationTemplatesPage } from "../types/channel.types.js";

const ButtonSchema = z.object({ type: z.string(), otp_type: z.string().optional() });
const PageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      language: z.string(),
      status: z.string(),
      category: z.string(),
      components: z
        .array(
          z.object({
            type: z.string(),
            code_expiration_minutes: z.number().int().nonnegative().optional(),
            buttons: z.array(ButtonSchema).optional(),
          }),
        )
        .optional(),
    }),
  ),
  paging: z
    .object({
      cursors: z.object({ after: z.string().max(2048).optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});

/** Return metadata only: never forward template examples or token-bearing paging URLs. */
export function authenticationTemplatesPage(
  input: unknown,
  approvedOnly: boolean,
): AuthenticationTemplatesPage {
  const page = PageSchema.parse(input);
  const templates = page.data
    .filter(
      (item) => item.category === "AUTHENTICATION" && (!approvedOnly || item.status === "APPROVED"),
    )
    .map((item) => {
      const buttons = item.components?.find((component) => component.type === "BUTTONS")?.buttons;
      const otpButtonType = buttons?.[0]?.otp_type?.toUpperCase() ?? null;
      return {
        id: item.id,
        name: item.name,
        languageCode: item.language,
        status: item.status,
        otpButtonType,
        // Unknown metadata is not a promise of compatibility with the copy-code sender.
        compatibleWithSendOtp:
          item.status === "APPROVED" &&
          otpButtonType === "COPY_CODE" &&
          buttons?.length === 1 &&
          ["OTP", "URL"].includes(buttons[0].type),
        codeExpirationMinutes:
          item.components?.find((component) => component.type === "FOOTER")
            ?.code_expiration_minutes ?? null,
      };
    });
  const nextCursor = page.paging?.next ? (page.paging.cursors?.after ?? null) : null;
  if (page.paging?.next && !nextCursor)
    throw new Error("Missing authentication template pagination cursor");
  return { templates, nextCursor, hasMore: nextCursor !== null };
}
