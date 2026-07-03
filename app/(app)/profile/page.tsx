import { currentUser } from "@clerk/nextjs/server";

export default async function ProfilePage() {
  const user = await currentUser();

  const name = user?.fullName || user?.firstName || user?.lastName || "—";
  const email = user?.primaryEmailAddress?.emailAddress ?? "—";

  return (
    <main style={{ padding: "3rem 1.5rem" }}>
      <h1>Profile</h1>
      <p>Name: {name}</p>
      <p>Email: {email}</p>
    </main>
  );
}
