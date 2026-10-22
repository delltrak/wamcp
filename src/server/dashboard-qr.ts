// ============================================================
// WA MCP — QR image for the operations dashboard
// ============================================================

import QRCode from "qrcode";

/** SVG data URL for an in-progress pairing QR. Returns null for empty or unsafe output. */
export async function renderQrDataUrl(text: string): Promise<string | null> {
  if (text.length < 1 || text.length > 2048) return null;
  const svg = await QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
  });
  if (!svg.startsWith("<svg") || svg.includes("<script")) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
