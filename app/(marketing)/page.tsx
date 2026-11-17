import { ButtonLink } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import styles from "./marketing.module.css";

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "calendar",
    title: "Scheduling without the group chat",
    body: "Invite your team to a service week and see who's confirmed at a glance.",
  },
  {
    icon: "music",
    title: "Setlists everyone can find",
    body: "Build the set, pick keys, publish once. Charts are attached to the songs.",
  },
  {
    icon: "bell",
    title: "Reminders that actually arrive",
    body: "Invitations, changes and rehearsal reminders go straight to each person.",
  },
];

export default function MarketingPage() {
  return (
    <main id="main">
      <section className={styles.hero}>
        <div className={styles.heroInner}>
          <h1 className={styles.title}>Graceful</h1>
          <p className={styles.tagline}>
            Scheduling, setlist, and music coordination for worship teams.
          </p>
          <div className={styles.actions}>
            <ButtonLink href="/sign-up" variant="accent" size="lg">
              Get started
            </ButtonLink>
            <ButtonLink href="/sign-in" variant="secondary" size="lg">
              Sign in
            </ButtonLink>
          </div>
        </div>
      </section>
      <section className={styles.features} aria-label="What Graceful does">
        {FEATURES.map((feature) => (
          <div key={feature.title} className={styles.feature}>
            <span className={styles.featureIcon}>
              <Icon name={feature.icon} size={24} />
            </span>
            <h2>{feature.title}</h2>
            <p>{feature.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
