import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';
import { join } from 'path';
import { readFileSync } from 'fs';

/**
 * Build the bounty.png attachment from the project assets folder.
 * Returns null if the file doesn't exist (so the bot works without it).
 * @returns {AttachmentBuilder|null}
 */
export function buildBountyAttachment() {
  try {
    const imagePath = join(process.cwd(), 'assets', 'bounty.png');
    const buffer = readFileSync(imagePath);
    return new AttachmentBuilder(buffer, { name: 'bounty.png' });
  } catch {
    return null;
  }
}

/**
 * Build the Bounty Rune embed + claim button.
 * @param {number} goldReward
 * @returns {{ embed: EmbedBuilder, row: ActionRowBuilder, attachment: AttachmentBuilder }}
 */
export function buildBountyMessage(goldReward) {
  const attachment = buildBountyAttachment();

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f) // gold/yellow
    .setTitle('Bounty Rune')
    .setDescription(
      `**Pojawiła się Bounty Runa!** Kto pierwszy kliknie **Zbierz runę**, zgarnia **${goldReward} Golda**! Złota nigdy za mało. Kto wie, może kiedyś się do czegoś przyda 😎`
    )
    .setThumbnail('attachment://bounty.png')
    .setFooter({ text: 'Kliknij przycisk poniżej, aby zebrać nagrodę!' })
    .setTimestamp();

  const button = new ButtonBuilder()
    .setCustomId('bounty_claim')
    .setLabel('Zbierz runę')
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(button);

  return { embed, row, attachment };
}
