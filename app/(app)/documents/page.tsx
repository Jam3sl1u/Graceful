import { Page, PageHeader } from "@/components/ui/Page";
import { EmptyState } from "@/components/ui/States";

// PRD wireframe screen 4
export default function Page_() {
  return (
    <Page>
      <PageHeader title="Document Library" />
      <EmptyState icon="file" compact={false} title="Coming soon">
        Charts and lead sheets for each song already appear on your week view.
      </EmptyState>
    </Page>
  );
}
