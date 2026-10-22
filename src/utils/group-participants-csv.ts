// ============================================================
// WA MCP — Group participant CSV export
// ============================================================

import type { GroupParticipantExport } from "../types/channel.types.js";

export const GROUP_PARTICIPANT_CSV_HEADERS = [
  "jid",
  "phone",
  "lid",
  "name",
  "push_name",
  "role",
] as const;

/** Serialize participants as UTF-8 CSV that spreadsheet apps can open. */
export function renderGroupParticipantsCsv(participants: GroupParticipantExport[]): string {
  const lines = [GROUP_PARTICIPANT_CSV_HEADERS.join(",")];
  for (const participant of participants) {
    lines.push(
      [
        csvCell(participant.jid),
        csvCell(participant.phone ?? ""),
        csvCell(participant.lid ?? ""),
        csvCell(participant.name ?? ""),
        csvCell(participant.pushName ?? ""),
        csvCell(participant.role),
      ].join(","),
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function groupParticipantsExportFileName(groupJid: string): string {
  const safeGroupJid = groupJid.replaceAll("@", "_").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `group-${safeGroupJid || "group"}-participants.csv`;
}

function csvCell(value: string): string {
  let cell = value;
  if (/^(?:\s*[=+\-@]|[\t\r\n])/.test(cell)) cell = `'${cell}`;
  if (/[",\r\n]/.test(cell)) return `"${cell.replaceAll('"', '""')}"`;
  return cell;
}
