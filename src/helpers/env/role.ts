export type ProcessRole = "worker" | "http" | "combined";

export function getProcessRole(): ProcessRole {
  const raw = (process.env.PROCESS_ROLE ?? "combined").toLowerCase();
  if (raw === "worker" || raw === "http") return raw;
  return "combined";
}

export function isWorker(): boolean {
  const role = getProcessRole();
  return role === "worker" || role === "combined";
}
