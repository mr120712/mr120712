// @polsia:user-owned — pagina Premi: inviti, fondatori, ascolta e guadagna, fedeltà e compleanno.
'use client';

import { Cake, Copy, Crown, Gem, Gift, Headphones, Share2, Users } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { REWARDS } from '@/lib/business/rewards';
import { type RewardsSummary, RewardsSummarySchema } from '@/lib/contracts/rewards';
import styles from './rewards-view.module.css';

const reasonLabels: Record<string, string> = {
  referral_invitee: 'Invito accettato',
  referral_inviter: 'Amico invitato',
  referral_milestone: 'Traguardo inviti',
  founder: 'Fondatore Solco',
  listening: 'Ascolta e guadagna',
  loyalty: 'Utente fedele',
  birthday: 'Buon compleanno!',
};

const months = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
];

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function Progress({ value, max }: { value: number; max: number }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <span
      className={styles.progress}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
    >
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export function RewardsView() {
  const { data: session, isPending } = useSession();
  const [summary, setSummary] = useState<RewardsSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [day, setDay] = useState('');
  const [month, setMonth] = useState('');

  const load = useCallback(async () => {
    try {
      setSummary(await apiFetch('/api/rewards', { schema: RewardsSummarySchema }));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (session?.user) void load();
  }, [load, session?.user]);

  if (isPending)
    return (
      <main className={styles.page}>
        <p className={styles.muted}>Caricamento…</p>
      </main>
    );

  if (!session?.user) {
    return (
      <main className={styles.page}>
        <h1>Premi Solco</h1>
        <p className={styles.lead}>
          Invita amici, ascolta e festeggia con noi: ogni premio sblocca giorni di Premium gratis.
        </p>
        <div className={styles.actions}>
          <Button asChild>
            <Link href="/signup">Registrati</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/login">Accedi</Link>
          </Button>
        </div>
      </main>
    );
  }

  const inviteUrl = summary ? `${window.location.origin}/invito/${summary.code}` : '';
  const share = async () => {
    const text =
      'Ascolta musica, radio e podcast con me su Solco: con questo invito ricevi 1 mese di Premium gratis.';
    if (navigator.share) {
      await navigator.share({ title: 'Solco', text, url: inviteUrl }).catch(() => undefined);
      return;
    }
    await navigator.clipboard.writeText(inviteUrl);
    toast.success('Link di invito copiato.');
  };

  const saveBirthday = async (event: FormEvent) => {
    event.preventDefault();
    if (!day || !month) return;
    try {
      await apiFetch('/api/rewards', {
        method: 'POST',
        body: JSON.stringify({
          action: 'set_birthday',
          birthday: `${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
        }),
      });
      toast.success('Compleanno salvato: ti aspetta un regalo!');
      void load();
    } catch {
      toast.error('Data non valida o già impostata.');
    }
  };

  const qualified = summary?.friends.qualified ?? 0;
  const nextMilestone = REWARDS.referralMilestones.find((m) => qualified < m.friends);

  return (
    <main className={styles.page}>
      <header>
        <h1>Premi Solco</h1>
        <p className={styles.lead}>
          Ogni premio sblocca giorni di Premium gratis: si sommano tra loro.
        </p>
      </header>

      {failed ? (
        <p className={styles.muted}>I premi non sono disponibili in questo momento.</p>
      ) : null}
      {!summary && !failed ? <p className={styles.muted}>Caricamento dei premi…</p> : null}

      {summary ? (
        <>
          <section className={styles.status} aria-live="polite">
            <Crown aria-hidden="true" />
            <div>
              <strong>
                {summary.premiumUntil
                  ? `Premium gratis fino al ${formatDate(summary.premiumUntil)}`
                  : 'Nessun premio attivo'}
              </strong>
              {summary.founderNumber ? (
                <span className={styles.badge}>Fondatore #{summary.founderNumber}</span>
              ) : null}
            </div>
          </section>

          <section className={styles.card} aria-labelledby="invite-heading">
            <Users aria-hidden="true" className={styles.icon} />
            <h2 id="invite-heading">Invita i tuoi amici</h2>
            <ul className={styles.tiers}>
              <li>
                <strong>1 amico</strong> 1 mese di Premium a entrambi
              </li>
              <li>
                <strong>3 amici</strong> +3 mesi di Premium
              </li>
              <li>
                <strong>5 amici</strong> +6 mesi di Premium (VIP)
              </li>
            </ul>
            <div className={styles.inviteRow}>
              <input readOnly value={inviteUrl} aria-label="Il tuo link di invito" />
              <Button type="button" onClick={() => void share()}>
                <Share2 aria-hidden="true" /> Condividi
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(inviteUrl)
                    .then(() => toast.success('Link copiato.'))
                }
              >
                <Copy aria-hidden="true" /> Copia
              </Button>
            </div>
            <p className={styles.muted}>
              Amici registrati: {summary.friends.joined} · qualificati: {qualified}
              {nextMilestone
                ? ` · prossimo traguardo: ${nextMilestone.friends} amici`
                : ' · tutti i traguardi raggiunti!'}
            </p>
            <Progress value={qualified} max={5} />
            <p className={styles.small}>
              Un amico conta quando si registra con il tuo link e ascolta almeno 30 minuti in 2
              giorni diversi.
            </p>
          </section>

          <section className={styles.card} aria-labelledby="listen-heading">
            <Headphones aria-hidden="true" className={styles.icon} />
            <h2 id="listen-heading">Ascolta e guadagna</h2>
            <p>Ogni 10 giorni in cui ascolti almeno 10 minuti, ricevi 1 giorno di Premium.</p>
            <Progress
              value={REWARDS.listeningDaysPerReward - summary.listening.nextRewardIn}
              max={REWARDS.listeningDaysPerReward}
            />
            <p className={styles.muted}>
              Giorni di ascolto: {summary.listening.qualifyingDays} · prossimo premio tra{' '}
              {summary.listening.nextRewardIn} giorni
            </p>
          </section>

          <section className={styles.card} aria-labelledby="founder-heading">
            <Gift aria-hidden="true" className={styles.icon} />
            <h2 id="founder-heading">Fondatori</h2>
            <p>
              {summary.founderNumber
                ? `Sei tra i primi 100 iscritti (#${summary.founderNumber}): hai ricevuto 1 mese di Premium e il badge Fondatore.`
                : 'I primi 100 iscritti hanno ricevuto 1 mese di Premium e il badge Fondatore.'}
            </p>
          </section>

          <section className={styles.card} aria-labelledby="loyal-heading">
            <Gem aria-hidden="true" className={styles.icon} />
            <h2 id="loyal-heading">Utente fedele</h2>
            <p>
              Dopo 6 mesi di abbonamento ricevi 1 mese gratis, che parte alla fine del periodo
              pagato.
            </p>
            {summary.loyaltyMonths !== null ? (
              <>
                <Progress value={summary.loyaltyMonths} max={REWARDS.loyaltyMonths} />
                <p className={styles.muted}>Mesi di abbonamento: {summary.loyaltyMonths}</p>
              </>
            ) : (
              <p className={styles.muted}>
                <Link href="/piani">Scopri i piani</Link>
              </p>
            )}
          </section>

          <section className={styles.card} aria-labelledby="bday-heading">
            <Cake aria-hidden="true" className={styles.icon} />
            <h2 id="bday-heading">Regalo di compleanno</h2>
            <p>Il giorno del tuo compleanno ricevi 7 giorni di Premium.</p>
            {summary.birthday ? (
              <p className={styles.muted}>
                Compleanno: {Number(summary.birthday.slice(3))}{' '}
                {months[Number(summary.birthday.slice(0, 2)) - 1]}
              </p>
            ) : (
              <form className={styles.inviteRow} onSubmit={(event) => void saveBirthday(event)}>
                <label className="sr-only" htmlFor="bday-day">
                  Giorno
                </label>
                <select id="bday-day" value={day} onChange={(event) => setDay(event.target.value)}>
                  <option value="">Giorno</option>
                  {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <label className="sr-only" htmlFor="bday-month">
                  Mese
                </label>
                <select
                  id="bday-month"
                  value={month}
                  onChange={(event) => setMonth(event.target.value)}
                >
                  <option value="">Mese</option>
                  {months.map((name, index) => (
                    <option key={name} value={String(index + 1)}>
                      {name}
                    </option>
                  ))}
                </select>
                <Button type="submit" disabled={!day || !month}>
                  Salva
                </Button>
              </form>
            )}
            <p className={styles.small}>La data si imposta una sola volta. Non chiediamo l’anno.</p>
          </section>

          {summary.grants.length > 0 ? (
            <section className={styles.card} aria-labelledby="history-heading">
              <h2 id="history-heading">I tuoi premi</h2>
              <ul className={styles.history}>
                {summary.grants.map((grant) => (
                  <li key={`${grant.reason}-${grant.startsAt}`}>
                    <strong>{reasonLabels[grant.reason] ?? grant.reason}</strong>
                    <span>
                      {grant.days} {grant.days === 1 ? 'giorno' : 'giorni'} · dal{' '}
                      {formatDate(grant.startsAt)} al {formatDate(grant.endsAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
