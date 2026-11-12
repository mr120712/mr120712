// @polsia:user-owned — pubblica subito un brano appena creato (usato da upload e registratore).
import { apiFetch } from '@/lib/api-client';
import { type Recording, RecordingPublishResponseSchema } from '@/lib/contracts/recordings';

/**
 * Pubblica un brano appena salvato nella classifica community. Se la pubblicazione fallisce,
 * ritorna il brano non pubblicato (resta privato, pubblicabile poi dalla lista).
 */
export async function publishNewRecording(
  recording: Recording,
): Promise<{ recording: Recording; published: boolean }> {
  try {
    const { recording: updated } = await apiFetch(`/api/music/recordings/${recording.id}/publish`, {
      method: 'POST',
      body: JSON.stringify({ published: true }),
      schema: RecordingPublishResponseSchema,
    });
    return { recording: updated, published: true };
  } catch {
    return { recording, published: false };
  }
}
