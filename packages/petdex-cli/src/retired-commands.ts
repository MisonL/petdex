// Commands that moved to the Petdex Desktop app keep a useful redirect in
// the CLI so existing agent configuration does not fail with "Unknown command".
export const DESKTOP_START_REDIRECT =
  "The desktop app runs on its own. Launch Petdex from Applications.";
export const DESKTOP_STOP_REDIRECT =
  "Quit Petdex from its menu bar icon to stop it.";

export const RETIRED_COMMANDS = new Map<string, string>([
  ["init", "The desktop app installs its own agent hooks from Settings."],
  ["up", DESKTOP_START_REDIRECT],
  ["start", DESKTOP_START_REDIRECT],
  ["restart", DESKTOP_START_REDIRECT],
  ["down", DESKTOP_STOP_REDIRECT],
  ["stop", DESKTOP_STOP_REDIRECT],
  ["toggle", "Toggle the mascot from the Petdex menu bar icon."],
  ["desktop", "The desktop app manages its own lifecycle."],
  ["select", "Select pets from the Petdex desktop app."],
  ["update", "The desktop app updates itself automatically."],
  ["doctor", "Petdex Settings shows agent and hook status directly."],
  ["hooks", "Install agent hooks from Petdex Settings, one click per agent."],
]);

export type RetiredCommandStyles = {
  yellow: (value: string) => string;
  bold: (value: string) => string;
  underline: (value: string) => string;
  cyan: (value: string) => string;
};

const PLAIN_STYLES: RetiredCommandStyles = {
  yellow: (value) => value,
  bold: (value) => value,
  underline: (value) => value,
  cyan: (value) => value,
};

export function formatRetiredCommand(
  command: string,
  version: string,
  downloadUrl: string,
  styles: RetiredCommandStyles = PLAIN_STYLES,
): string {
  const detail = RETIRED_COMMANDS.get(command) ?? "";
  return [
    "",
    `  ${styles.yellow("!")} ${styles.bold(`petdex ${command}`)} was removed in v${version.split(".")[0]}.`,
    "",
    `  ${detail}`,
    `  Get the app: ${styles.underline(downloadUrl)}`,
    "",
    `  This CLI now manages the pet catalog: ${styles.cyan("petdex list")}, ${styles.cyan("petdex install <slug>")}.`,
    "",
  ].join("\n");
}
