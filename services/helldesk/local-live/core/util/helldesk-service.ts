/** Local HELLDESK service — disabled locally (CTO: single-user, no wanteds). */
export interface HelldeskService {
  browseWantedBoard(args?: { wanted_id?: string; status?: string }): Promise<{ wanted: unknown[] }>;
  claimWantedItem(args?: { wanted_id?: string; claimer_id?: string }): Promise<{ ok: boolean; reason?: string }>;
  postWantedItem(args?: { title?: string; description?: string; wanted_id?: string }): Promise<{ ok: boolean; reason?: string }>;
  markWantedItemDone(args?: { wanted_id?: string; done?: boolean }): Promise<{ ok: boolean; reason?: string }>;
}