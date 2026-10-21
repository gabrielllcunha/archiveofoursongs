import type { NextApiRequest, NextApiResponse } from 'next';
import { requireSupabaseAnonClientFromBearer } from '@/utils/server/requireSupabaseAnonFromBearer';
import { isSystemManagerAccount } from '@/utils/server/lastfmWhitelist';
import { fetchLastfmRegisteredYear } from '@/utils/server/lastfmSession';

const CUSTOM_EARLIEST_YEAR = 2021;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = requireSupabaseAnonClientFromBearer(req, res);
  if (!auth) return;

  const { data: { user }, error } = await auth.client.auth.getUser(auth.accessToken);
  if (error || !user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const lastfmUsername = user.user_metadata?.lastfm_username;
  const isSystemManager =
    typeof lastfmUsername === 'string' && isSystemManagerAccount(lastfmUsername);
  const canAccessCurrentYear = isSystemManager;

  const fallbackEarliest = new Date().getFullYear() - 1;
  let earliestSelectableYear = fallbackEarliest;

  if (canAccessCurrentYear) {
    earliestSelectableYear = CUSTOM_EARLIEST_YEAR;
  } else if (typeof lastfmUsername === 'string') {
    const joinedYear = await fetchLastfmRegisteredYear(lastfmUsername);
    if (joinedYear !== null) {
      earliestSelectableYear = joinedYear;
    }
  }

  return res.status(200).json({ canAccessCurrentYear, earliestSelectableYear, isSystemManager });
}
