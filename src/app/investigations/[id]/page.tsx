import { InvestigationView } from "@/components/InvestigationView";

export const metadata = { title: "Investigation · Incident Investigator" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvestigationView id={id} />;
}
