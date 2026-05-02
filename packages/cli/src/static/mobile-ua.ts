// Static UA strings — hand-curated, updated 2026-04 against real device strings.
// Do NOT randomize. The same UA must produce the same run.

export const MOBILE_USER_AGENTS = {
  ios:     'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
} as const;

export type MobilePlatform = keyof typeof MOBILE_USER_AGENTS;

export function uaForViewport(platform: MobilePlatform, override?: string): string {
  return override ?? MOBILE_USER_AGENTS[platform];
}
