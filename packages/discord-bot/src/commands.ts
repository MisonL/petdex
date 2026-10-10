// Slash command definitions for the Petdex bot. Kept as pure data so
// `register-commands.ts` can ship them to Discord and `bot.ts` can
// dispatch on `interaction.commandName` using the same source of truth.

import {
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
  escapeMarkdown,
  SlashCommandBuilder,
} from "discord.js";

const PETDEX_API_BASE = process.env.PETDEX_API_BASE ?? "https://petdex.dev";

export const commandData = [
  new SlashCommandBuilder()
    .setName("install")
    .setDescription("Show the install command for a Petdex pet")
    .addStringOption((opt) =>
      opt
        .setName("slug")
        .setDescription("Pet slug, e.g. boba")
        .setRequired(true)
        // Bounded: the reply interpolates the raw value into a channel message,
        // and Discord rejects content over 2000 chars, so an unlimited slug was
        // both a long dead link and a way to make the reply itself throw.
        .setMaxLength(100),
    ),

  new SlashCommandBuilder()
    .setName("featured")
    .setDescription("List the current featured collections"),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the top 5 creators on Petdex"),

  new SlashCommandBuilder()
    .setName("collection")
    .setDescription("Show pets in a featured collection")
    .addStringOption((opt) =>
      opt
        .setName("slug")
        .setDescription("Collection slug, e.g. graycraft, anime-heroes")
        .setRequired(true)
        .setMaxLength(100),
    ),
].map((c) => c.toJSON());

type Handler = (
  interaction: ChatInputCommandInteraction,
  client: Client,
) => Promise<void>;

// Discord invalidates an interaction token 3 seconds after the last
// response. Every handler that talks to the Petdex API defers first and
// bounds the fetch, so a slow API can no longer blow the 3s window, then
// fail again inside the error path, and reject unhandled.
const FETCH_TIMEOUT_MS = 8000;

async function ephemeralNotice(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  // The handler already spent its deferred response on the network wait,
  // and a deferred response can never become ephemeral. Drop it and follow
  // up, which is the only route back to an ephemeral message.
  try {
    await interaction.deleteReply();
  } catch {
    /* already gone */
  }
  await interaction.followUp({ content, ephemeral: true });
}

export const handlers: Record<string, Handler> = {
  install: async (interaction) => {
    await interaction.deferReply();
    const slug = interaction.options.getString("slug", true).toLowerCase();
    const url = `${PETDEX_API_BASE}/api/manifest`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await ephemeralNotice(
        interaction,
        `Could not reach Petdex (${res.status}). Try later.`,
      );
      return;
    }
    const data = (await res.json()) as {
      pets: Array<{ slug: string; displayName: string }>;
    };
    const pet = data.pets.find((p) => p.slug === slug);
    if (!pet) {
      await ephemeralNotice(
        interaction,
        `No pet with slug \`${slug}\`. Try \`/featured\` for ideas.`,
      );
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(pet.displayName)
      .setURL(`${PETDEX_API_BASE}/pets/${pet.slug}`)
      .setColor(0x5266ea)
      .setDescription(`\`npx petdex install ${pet.slug}\``)
      .setImage(`${PETDEX_API_BASE}/pets/${pet.slug}/opengraph-image`);
    await interaction.editReply({ embeds: [embed] });
  },

  featured: async (interaction) => {
    await interaction.deferReply();
    const res = await fetch(`${PETDEX_API_BASE}/api/manifest`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await ephemeralNotice(
        interaction,
        `Could not reach Petdex (${res.status}).`,
      );
      return;
    }
    // The manifest doesn't expose collections yet — link the page until
    // /api/collections lands. Listing 10 names hard-coded is brittle.
    await interaction.editReply({
      content:
        "Browse all featured collections at " +
        `${PETDEX_API_BASE}/collections — GRAYCRAFT, Anime Heroes, ` +
        "Cats Universe, Coders Club, and more.",
    });
  },

  leaderboard: async (interaction) => {
    await interaction.reply({
      content:
        `🏆 Top creators live at ${PETDEX_API_BASE}/leaderboard — ` +
        "ranks update as new pets are approved.",
    });
  },

  collection: async (interaction) => {
    const slug = interaction.options.getString("slug", true).toLowerCase();
    await interaction.reply({
      content: `Browse the **${escapeMarkdown(slug)}** collection at ${PETDEX_API_BASE}/collections/${slug}`,
      // The slug is caller input interpolated into a channel-visible
      // message, and interaction responses parse user mentions by default.
      // Suppress every mention type; there is none worth keeping here.
      allowedMentions: { parse: [] },
    });
  },
};
