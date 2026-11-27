// Swamp permissions plugin for Amp
// Asks before running a shell command that reads a vault secret, and allows
// every other tool call (Amp's default).
// This is a managed file — it will be overwritten on swamp upgrade.

import type { PluginAPI } from "@ampcode/plugin";

export const description = "Asks before running swamp vault read-secret; allows every other tool call.";

export default function (amp: PluginAPI) {
  amp.on("tool.call", async (event, ctx) => {
    const shell = amp.helpers.shellCommandFromToolCall(event);
    if (!shell || !shell.command.includes("read-secret")) {
      return { action: "allow" };
    }
    try {
      const approved = await ctx.ui.confirm({
        title: "Allow swamp vault read-secret?",
        message: shell.command,
        confirmButtonText: "Allow",
        requireHuman: true,
        skipIfUnwatched: true,
      });
      if (approved) return { action: "allow" };
    } catch {
      // No one to ask (e.g. amp --execute): refuse rather than run it.
    }
    return {
      action: "reject-and-continue",
      message: "The user did not approve reading a vault secret: " +
        shell.command,
    };
  });
}
