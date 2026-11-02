import { AlertLogView } from "@/components/AlertLogView";
import { TelemetryProvider } from "@/lib/telemetry-store";

export const metadata = {
  title: "Alerts — ARL Control",
};

export default function AlertsPage() {
  return (
    <TelemetryProvider service={null}>
      <AlertLogView />
    </TelemetryProvider>
  );
}
