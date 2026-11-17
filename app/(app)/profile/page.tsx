import { currentUser } from "@clerk/nextjs/server";
import { SignOutButton } from "@clerk/nextjs";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Page, PageHeader } from "@/components/ui/Page";
import styles from "./profile.module.css";

export default async function ProfilePage() {
  const user = await currentUser();

  const name = user?.fullName || user?.firstName || user?.lastName || "—";
  const email = user?.primaryEmailAddress?.emailAddress ?? "—";

  return (
    <Page width="narrow">
      <PageHeader title="Profile" />
      <Card className={styles.card}>
        <div className={styles.identity}>
          <Avatar name={name === "—" ? email : name} />
          <dl className={styles.details}>
            <div>
              <dt>Name</dt>
              <dd>{name}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{email}</dd>
            </div>
          </dl>
        </div>
        <SignOutButton>
          <Button variant="secondary">Sign out</Button>
        </SignOutButton>
      </Card>
    </Page>
  );
}
