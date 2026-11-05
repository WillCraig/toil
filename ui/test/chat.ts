// Opening the chat in a view test (#343): press into the Ask bar, as a person
// would, and get the focused view it opens.

import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/** The Ask bar of the toil project on screen. */
export const askBar = (toilProject: string) => screen.getByRole('region', { name: `Ask about ${toilProject}` });

/** Presses into the Ask bar and returns the focused view's dialog. */
export async function openChat(toilProject: string): Promise<HTMLElement> {
  const bar = await screen.findByRole('region', { name: `Ask about ${toilProject}` });
  await userEvent.click(within(bar).getByRole('textbox', { name: 'Your question' }));
  return screen.findByRole('dialog', { name: `Ask about ${toilProject}` });
}
