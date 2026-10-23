/** "… truncated (12 KB total)": the size of the whole pretty-printed payload, in KB of ASCII. */
export function truncatedNote(length: number): string {
  return `… truncated (${String(Math.ceil(length / 1024))} KB total)`;
}
