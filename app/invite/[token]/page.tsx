import { InviteAcceptance } from "@/app/invitations/invite-acceptance";

export default async function InvitePage({ params }: Readonly<{ params: Promise<{ token: string }> }>) {
  const { token } = await params;
  return <InviteAcceptance token={token} />;
}
