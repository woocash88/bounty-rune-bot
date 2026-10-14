import { makeSettingCommand } from '../utils/settingCommand.js';
import { recomputeSchedule } from '../scheduler/bountyScheduler.js';

// Changing the rate only affects spawns scheduled from now on, so re-roll the
// pending spawn immediately to make the new value take effect.
export default makeSettingCommand('bounty_avg_per_week', 'avg_per_week', async (interaction) => {
  const { nextDate } = await recomputeSchedule(interaction.client);
  return `🔄 Przeliczono termin następnej Bounty Runy: <t:${Math.floor(nextDate.getTime() / 1000)}:F>`;
});
