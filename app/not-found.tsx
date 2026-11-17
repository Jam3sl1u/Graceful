import { ButtonLink } from "@/components/ui/Button";
import { Page } from "@/components/ui/Page";
import { NoticeState } from "@/components/ui/States";

export default function NotFound() {
  return (
    <Page width="narrow">
      <NoticeState
        icon="search"
        tone="info"
        title="We couldn't find that page"
        actions={
          <ButtonLink href="/" variant="primary">
            Go to the start
          </ButtonLink>
        }
      >
        The link may be out of date, or the page may have moved.
      </NoticeState>
    </Page>
  );
}
