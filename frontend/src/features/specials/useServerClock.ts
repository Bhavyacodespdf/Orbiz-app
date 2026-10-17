import { useEffect, useState } from 'react';

/**
 * The server's current time, ticking every second. Voting windows are judged by the
 * server's clock, so countdowns follow it rather than a possibly wrong device clock.
 */
export function useServerClock(serverNowIso: string): number {
  const [now, setNow] = useState(() => Date.parse(serverNowIso));
  useEffect(() => {
    const offset = Date.parse(serverNowIso) - Date.now();
    const id = window.setInterval(() => setNow(Date.now() + offset), 1000);
    return () => window.clearInterval(id);
  }, [serverNowIso]);
  return now;
}
