"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatNumber, formatTime, timeAgo, titleCase } from "@/lib/format";
import {
  deriveMheAlerts,
  getCrew,
  getHabitatStatus,
  getRooms,
  summarizeCrew,
  summarizeRooms,
} from "@/lib/mhe-selectors";
import { useTelemetry } from "@/lib/telemetry-store";
import { SERVICE_ACCENT } from "@/lib/theme";
import {
  MHE_CO2_LIMIT_PPM,
  MHE_HEART_RATE_LIMIT_BPM,
  MHE_ROOMS,
  type MheCrewSurvey,
} from "@/lib/types";
import { useCommandRunner } from "@/lib/use-command";
import { useNow } from "@/lib/use-now";
import { useOperator } from "@/lib/use-operator";
import { AlertAnnunciator } from "../AlertAnnunciator";
import { ServiceHeader } from "../ServiceHeader";
import { ConfirmButton } from "../ConfirmButton";
import { InsightPanel } from "../InsightPanel";
import { PermissionNote } from "../PermissionNote";
import { PresetPanel } from "../PresetPanel";
import { ReplayBar } from "../ReplayBar";
import { Badge, EmptyState, Metric, Panel, ProgressBar, StatusDot } from "../ui";
import { HabitatLayout } from "./HabitatLayout";

const SURVEY_FIELDS: Array<{ key: keyof MheCrewSurvey; label: string }> = [
  { key: "mood", label: "Mood" },
  { key: "stress", label: "Stress" },
  { key: "fatigue", label: "Fatigue" },
  { key: "sleepQuality", label: "Sleep quality" },
];

export function MHEView() {
  const { topics, mode, lastTelemetryAt } = useTelemetry();
  const { operator, setOperator } = useOperator();
  const { run, pending, feedback } = useCommandRunner();
  const now = useNow(30_000);

  const [selectedRoomId, setSelectedRoomId] = useState("common");
  const [temperatureDraft, setTemperatureDraft] = useState("22");
  const [humidityDraft, setHumidityDraft] = useState("45");
  const [ventilationDraft, setVentilationDraft] = useState("120");
  const [lightDraft, setLightDraft] = useState(800);
  const [lightWindowStart, setLightWindowStart] = useState("06:00");
  const [lightWindowEnd, setLightWindowEnd] = useState("22:00");
  const [irrigationStart, setIrrigationStart] = useState("06:00");
  const [irrigationEnd, setIrrigationEnd] = useState("06:30");
  const [irrigationVolume, setIrrigationVolume] = useState("40");

  const rooms = useMemo(() => getRooms(topics), [topics]);
  const crew = useMemo(() => getCrew(topics), [topics]);
  const habitat = useMemo(() => getHabitatStatus(topics), [topics]);
  const roomSummary = useMemo(() => summarizeRooms(rooms, now), [rooms, now]);
  const crewSummary = useMemo(() => summarizeCrew(crew, now), [crew, now]);
  const derivedAlerts = useMemo(() => deriveMheAlerts(rooms, crew, now), [rooms, crew, now]);

  const selectedRoom = useMemo(
    () => rooms.find((room) => room.id === selectedRoomId) ?? rooms[0] ?? null,
    [rooms, selectedRoomId],
  );

  /**
   * The drafts are seeded once per selected room, from the service's setpoints
   * when it publishes them and from telemetry otherwise. Seeding on every
   * telemetry tick would overwrite whatever the operator is typing, so the
   * room id is remembered instead — the panel always shows drift between the
   * seeded target and the live reading rather than silently re-writing it.
   */
  const hydratedRoom = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedRoom) return;
    if (hydratedRoom.current === selectedRoom.id) return;
    if (!selectedRoom.telemetry && !selectedRoom.setpoints) return;
    hydratedRoom.current = selectedRoom.id;

    const target = selectedRoom.setpoints;
    const live = selectedRoom.telemetry;
    const temperatureC = target?.temperatureC ?? live?.temperatureC;
    const humidityPct = target?.humidityPct ?? live?.humidityPct;
    const ventilationM3h = target?.ventilationM3h ?? live?.ventilationM3h;
    if (typeof temperatureC === "number") setTemperatureDraft(temperatureC.toFixed(1));
    if (typeof humidityPct === "number") setHumidityDraft(humidityPct.toFixed(0));
    if (typeof ventilationM3h === "number") setVentilationDraft(ventilationM3h.toFixed(0));
    if (typeof live?.lightingLux === "number") setLightDraft(Math.round(live.lightingLux));
    if (selectedRoom.lightingSchedule) {
      setLightWindowStart(selectedRoom.lightingSchedule.start ?? lightWindowStart);
      setLightWindowEnd(selectedRoom.lightingSchedule.end ?? lightWindowEnd);
    }
  }, [selectedRoom, lightWindowStart, lightWindowEnd]);

  /** Hydroponics runs grow lights an order of magnitude brighter than the rest. */
  const lightMaxLux = selectedRoom?.id === "hydroponics" ? 30000 : 1000;
  const isHydroponics = selectedRoom?.id === "hydroponics";
  const airlockState =
    habitat?.airlockState ??
    rooms.find((room) => room.id === "airlock")?.telemetry?.airlockState ??
    null;

  const issue = (control: string, entity: string, value: unknown, label: string) =>
    run({ service: "MHE", entity, control, value, researcher: operator }, label);

  const surveyScore = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 1), 10) : null;

  return (
    <div
      className="accent-scope space-y-4"
      style={{ "--accent": SERVICE_ACCENT.MHE } as React.CSSProperties}
    >
      <ServiceHeader
        index="02"
        service="Mars Habitation Experiment"
        title="9-room habitat & crew wellbeing"
        blurb="Room environment every 5 minutes, crew vitals every minute, surveys twice per mission day."
        accent="#ff7a45"
        status={
          <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">{habitat?.mode ? titleCase(String(habitat.mode)) : "habitat"}</Badge>
          <Badge tone="neutral">
            day {typeof habitat?.missionDay === "number" ? habitat.missionDay : "—"}
          </Badge>
          <Badge tone="neutral">{roomSummary.crewOnboard} crew onboard</Badge>
          <Badge tone="neutral">last telemetry {lastTelemetryAt ? timeAgo(lastTelemetryAt, now) : "—"}</Badge>
          {mode === "replay" && <Badge tone="warn">historical view</Badge>}
          </div>
        }
      />

      <ReplayBar service="MHE" />

      <PermissionNote service="MHE" code={operator} />

      {derivedAlerts.length > 0 && (
        <div className="panel border-console-warn/40 bg-console-warn/5 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {derivedAlerts.slice(0, 6).map((alert) => (
              <span
                key={alert.message}
                className={`flex items-center gap-2 text-xs ${
                  alert.tone === "alert" ? "text-console-alert" : "text-console-warn"
                }`}
              >
                <StatusDot tone={alert.tone} pulse />
                {alert.message}
              </span>
            ))}
            {derivedAlerts.length > 6 && (
              <span className="text-xs text-console-muted">+{derivedAlerts.length - 6} more in the annunciator</span>
            )}
          </div>
        </div>
      )}

      <InsightPanel
        question="Can the crew work a normal day in this habitat?"
        tone={
          (roomSummary.maxCo2Ppm ?? 0) >= MHE_CO2_LIMIT_PPM ||
          (crewSummary.maxHeartRate ?? 0) >= MHE_HEART_RATE_LIMIT_BPM
            ? "alert"
            : roomSummary.roomsReporting < MHE_ROOMS.length || roomSummary.staleRooms > 0
              ? "warn"
              : "ok"
        }
        answer={
          roomSummary.roomsReporting === 0
            ? "Not answerable — no room is reporting yet."
            : `Yes, with ${roomSummary.roomsReporting}/${MHE_ROOMS.length} rooms reporting: peak CO₂ ${
                roomSummary.maxCo2Ppm === null ? "—" : Math.round(roomSummary.maxCo2Ppm)
              } ppm against the ${MHE_CO2_LIMIT_PPM} ppm limit, mean ${formatNumber(
                roomSummary.averageTemperatureC,
                1,
              )} °C, ${roomSummary.crewOnboard} crew onboard.`
        }
        evidence={[
          {
            label: "Rooms reporting",
            value: `${roomSummary.roomsReporting} / ${MHE_ROOMS.length}`,
            percent: Math.round((roomSummary.roomsReporting / MHE_ROOMS.length) * 100),
            tone: roomSummary.roomsReporting === MHE_ROOMS.length ? "ok" : "warn",
            hint: `${roomSummary.staleRooms} stale`,
          },
          {
            label: "Peak CO₂",
            value: `${roomSummary.maxCo2Ppm === null ? "—" : Math.round(roomSummary.maxCo2Ppm)} ppm`,
            percent:
              roomSummary.maxCo2Ppm === null
                ? 0
                : Math.min(Math.round((roomSummary.maxCo2Ppm / MHE_CO2_LIMIT_PPM) * 100), 100),
            tone: (roomSummary.maxCo2Ppm ?? 0) >= MHE_CO2_LIMIT_PPM ? "alert" : "ok",
            hint: `limit ${MHE_CO2_LIMIT_PPM} ppm · min O₂ ${formatNumber(roomSummary.minO2Pct, 1)} %`,
          },
          {
            label: "Crew vitals",
            value:
              crewSummary.maxHeartRate === null
                ? "no readings"
                : `max ${Math.round(crewSummary.maxHeartRate)} bpm`,
            percent:
              crewSummary.maxHeartRate === null
                ? 0
                : Math.min(Math.round((crewSummary.maxHeartRate / MHE_HEART_RATE_LIMIT_BPM) * 100), 100),
            tone: (crewSummary.maxHeartRate ?? 0) >= MHE_HEART_RATE_LIMIT_BPM ? "alert" : "ok",
            hint: `${crew.length} tracked · limit ${MHE_HEART_RATE_LIMIT_BPM} bpm`,
          },
          {
            label: "Surveys (12 h)",
            value: `${crewSummary.surveysRecent} / 5`,
            percent: Math.round((crewSummary.surveysRecent / Math.max(crew.length, 1)) * 100),
            tone: crewSummary.surveysRecent >= crew.length ? "ok" : "warn",
            hint: "twice per mission day",
          },
        ]}
        footnote="Habitat questions are about habitability, not health: CO₂ and room coverage decide whether the crew can work, the vitals panel decides whether they should."
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel
            title="Habitat layout — 9 rooms"
            subtitle="Select a room to adjust its temperature, lighting and airlock state."
            actions={
              <>
                <Badge tone={roomSummary.roomsReporting === roomSummary.totalRoomCount ? "ok" : "warn"}>
                  {roomSummary.roomsReporting}/{roomSummary.totalRoomCount} reporting
                </Badge>
                {roomSummary.staleRooms > 0 && <Badge tone="warn">{roomSummary.staleRooms} stale</Badge>}
              </>
            }
          >
            <div className="mb-3 grid gap-2 sm:grid-cols-4">
              <Metric
                label="Mean temperature"
                value={formatNumber(roomSummary.averageTemperatureC, 1)}
                unit="°C"
              />
              <Metric
                label="Peak CO₂"
                value={roomSummary.maxCo2Ppm !== null ? Math.round(roomSummary.maxCo2Ppm) : "—"}
                unit="ppm"
                tone={
                  roomSummary.maxCo2Ppm !== null && roomSummary.maxCo2Ppm >= MHE_CO2_LIMIT_PPM
                    ? "alert"
                    : "neutral"
                }
              />
              <Metric label="Minimum O₂" value={formatNumber(roomSummary.minO2Pct, 1)} unit="%" />
              <Metric
                label="Airlock"
                value={
                  habitat?.airlockState ??
                  (rooms.find((room) => room.id === "airlock")?.telemetry?.pressurized ? "PRESSURIZED" : "—")
                }
                hint="Habitability interlock"
              />
            </div>

            <HabitatLayout
              rooms={rooms}
              selectedId={selectedRoom?.id ?? null}
              onSelect={setSelectedRoomId}
              now={now}
            />
          </Panel>

          <Panel
            title="Crew vitals"
            subtitle="Heart rate and body temperature stream once per minute."
            actions={
              <Badge tone={crewSummary.alerts > 0 ? "alert" : "ok"}>
                {crewSummary.crewTracked}/5 reporting
              </Badge>
            }
          >
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {crew.map((member) => {
                const heartRate = member.health?.heartRateBpm;
                const bodyTemp = member.health?.bodyTemperatureC;
                const hrAlert = typeof heartRate === "number" && heartRate >= MHE_HEART_RATE_LIMIT_BPM;
                return (
                  <div
                    key={member.id}
                    className={`rounded-lg border px-3 py-2 ${
                      hrAlert ? "border-console-alert/60 bg-console-alert/10" : "border-console-edge/70 bg-console-void/40"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <p className="truncate text-sm text-console-ink">{member.name}</p>
                      <span className="font-mono text-[10px] uppercase text-console-muted">{member.id}</span>
                    </div>
                    <div className="mt-1 flex items-end justify-between">
                      <div>
                        <p className="font-mono text-xl">
                          {typeof heartRate === "number" ? Math.round(heartRate) : "—"}
                          <span className="ml-1 text-[10px] text-console-muted">bpm</span>
                        </p>
                        <p className="font-mono text-[11px] text-console-muted">
                          {formatNumber(bodyTemp, 1)} °C body
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn px-2 py-1 text-[9px]"
                        onClick={() =>
                          void issue(
                            "crew_wellness_check",
                            member.id,
                            true,
                            `Wellness check ${member.id}`,
                          )
                        }
                        disabled={pending !== null}
                      >
                        Check
                      </button>
                    </div>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-console-muted">
                      {member.healthAt ? `updated ${timeAgo(member.healthAt, now)}` : "no vitals yet"}
                    </p>
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel
            title="Daily crew surveys"
            subtitle="Mood, stress, fatigue and sleep quality are scored 1–10 and submitted twice per mission day."
            actions={
              <Badge tone={crewSummary.surveysRecent >= 5 ? "ok" : "warn"}>
                {crewSummary.surveysRecent}/5 within 12h
              </Badge>
            }
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {crew.map((member) => (
                <div key={member.id} className="rounded-lg border border-console-edge/70 bg-console-void/40 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-console-ink">{member.name}</p>
                    <span
                      className={`text-[10px] uppercase tracking-[0.12em] ${
                        member.surveyAt ? "text-console-muted" : "text-console-warn"
                      }`}
                    >
                      {member.surveyAt ? `submitted ${timeAgo(member.surveyAt, now)}` : "awaiting survey"}
                    </span>
                  </div>

                  {member.survey ? (
                    <div className="mt-2 space-y-1.5">
                      {SURVEY_FIELDS.map((field) => {
                        const score = surveyScore(member.survey?.[field.key]);
                        const inverted = field.key === "stress" || field.key === "fatigue";
                        const tone = score === null ? "neutral" : inverted ? (score >= 7 ? "alert" : score >= 5 ? "warn" : "ok") : score <= 4 ? "warn" : "ok";
                        return (
                          <div key={String(field.key)} className="flex items-center gap-2">
                            <span className="w-24 text-[10px] uppercase tracking-[0.1em] text-console-muted">
                              {field.label}
                            </span>
                            <div className="flex-1">
                              <ProgressBar value={score ?? 0} max={10} tone={tone} />
                            </div>
                            <span className="w-8 text-right font-mono text-[11px] text-console-ink">
                              {score ?? "—"}
                            </span>
                          </div>
                        );
                      })}
                      <p className="pt-1 text-[10px] text-console-muted">
                        {member.survey.missionDay !== undefined ? `mission day ${member.survey.missionDay}` : "mission day —"}
                        {member.surveyAt ? ` · ${formatTime(member.surveyAt)}` : ""}
                      </p>
                    </div>
                  ) : (
                    <div className="mt-2">
                      <EmptyState message="No survey on record." hint="Two submissions expected per mission day." />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <PresetPanel
            service="MHE"
            entity={selectedRoom?.id ?? null}
            operator={operator}
            run={run}
            pending={pending}
            title="Habitat presets"
          />

          <Panel
            title="Room & crew controls"
            subtitle={selectedRoom ? `Selected: ${titleCase(selectedRoom.id)}` : "Select a room"}
          >
            <div className="space-y-3">
              <div>
                <label className="label" htmlFor="mhe-operator">
                  Operator
                </label>
                <input
                  id="mhe-operator"
                  className="input"
                  value={operator}
                  onChange={(event) => setOperator(event.target.value)}
                  placeholder="Researcher name / ID"
                />
              </div>

              <div>
                <label className="label" htmlFor="room-temp">
                  Room temperature setpoint (°C)
                </label>
                <div className="flex gap-2">
                  <input
                    id="room-temp"
                    className="input"
                    inputMode="decimal"
                    value={temperatureDraft}
                    onChange={(event) => setTemperatureDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={pending !== null || !selectedRoom || !Number.isFinite(Number(temperatureDraft))}
                    onClick={() =>
                      selectedRoom &&
                      void issue(
                        "adjust_temperature",
                        selectedRoom.id,
                        Number(temperatureDraft) + 273.15,
                        `Set ${selectedRoom.id} to ${temperatureDraft} °C`,
                      )
                    }
                  >
                    Apply
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-console-muted">
                  Sent as kelvin ({formatNumber(Number(temperatureDraft) + 273.15, 2)} K); accepted
                  range 285–300 K.
                </p>
              </div>

              <div>
                <span className="label">Current state → target</span>
                <div className="grid grid-cols-2 gap-1 font-mono text-[10px] text-console-muted">
                  <span>
                    temp {formatNumber(selectedRoom?.telemetry?.temperatureC, 1)} →{" "}
                    <span className="text-console-ink">{temperatureDraft || "—"} °C</span>
                  </span>
                  <span>
                    RH {formatNumber(selectedRoom?.telemetry?.humidityPct, 0)} →{" "}
                    <span className="text-console-ink">{humidityDraft || "—"} %</span>
                  </span>
                  <span>
                    vent {formatNumber(selectedRoom?.telemetry?.ventilationM3h, 0)} →{" "}
                    <span className="text-console-ink">{ventilationDraft || "—"} m³/h</span>
                  </span>
                  <span>
                    light {formatNumber(selectedRoom?.telemetry?.lightingLux, 0)} →{" "}
                    <span className="text-console-ink">{lightDraft} lx</span>
                  </span>
                </div>
                <p className="mt-1 text-[10px] text-console-muted">
                  sealed {selectedRoom?.sealed === null ? "unknown" : selectedRoom?.sealed ? "yes" : "no"} ·
                  climate control{" "}
                  {selectedRoom?.environmentalSystems === null
                    ? "unknown"
                    : selectedRoom?.environmentalSystems
                      ? "on"
                      : "off"}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label" htmlFor="room-humidity">
                    Humidity (%)
                  </label>
                  <div className="flex gap-1">
                    <input
                      id="room-humidity"
                      className="input"
                      inputMode="decimal"
                      value={humidityDraft}
                      onChange={(event) => setHumidityDraft(event.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary px-2 text-[10px]"
                      disabled={
                        pending !== null ||
                        !selectedRoom ||
                        !Number.isFinite(Number(humidityDraft)) ||
                        Number(humidityDraft) < 20 ||
                        Number(humidityDraft) > 80
                      }
                      onClick={() =>
                        selectedRoom &&
                        void issue(
                          "adjust_humidity",
                          selectedRoom.id,
                          Number(humidityDraft),
                          `Set ${selectedRoom.id} humidity to ${humidityDraft} %`,
                        )
                      }
                    >
                      Apply
                    </button>
                  </div>
                </div>
                <div>
                  <label className="label" htmlFor="room-ventilation">
                    Ventilation (m³/h)
                  </label>
                  <div className="flex gap-1">
                    <input
                      id="room-ventilation"
                      className="input"
                      inputMode="decimal"
                      value={ventilationDraft}
                      onChange={(event) => setVentilationDraft(event.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary px-2 text-[10px]"
                      disabled={
                        pending !== null ||
                        !selectedRoom ||
                        !Number.isFinite(Number(ventilationDraft)) ||
                        Number(ventilationDraft) < 0 ||
                        Number(ventilationDraft) > 400
                      }
                      onClick={() =>
                        selectedRoom &&
                        void issue(
                          "ventilation",
                          selectedRoom.id,
                          Number(ventilationDraft),
                          `Set ${selectedRoom.id} ventilation to ${ventilationDraft} m3/h`,
                        )
                      }
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label className="label" htmlFor="room-light">
                  Lighting level — {lightDraft} lx
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="room-light"
                    type="range"
                    min={0}
                    max={lightMaxLux}
                    step={lightMaxLux <= 1000 ? 50 : 500}
                    value={Math.min(lightDraft, lightMaxLux)}
                    onChange={(event) => setLightDraft(Number(event.target.value))}
                    className="scrubber flex-1"
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={pending !== null || !selectedRoom}
                    onClick={() =>
                      selectedRoom &&
                      void issue(
                        "lighting_schedule",
                        selectedRoom.id,
                        { start: lightWindowStart, end: lightWindowEnd, level_lux: lightDraft },
                        `Set ${selectedRoom.id} lighting to ${lightDraft} lx`,
                      )
                    }
                  >
                    Apply
                  </button>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  <input
                    aria-label="Lighting window start"
                    className="input"
                    value={lightWindowStart}
                    onChange={(event) => setLightWindowStart(event.target.value)}
                    placeholder="06:00"
                  />
                  <input
                    aria-label="Lighting window end"
                    className="input"
                    value={lightWindowEnd}
                    onChange={(event) => setLightWindowEnd(event.target.value)}
                    placeholder="22:00"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="btn col-span-1"
                  disabled={pending !== null || !selectedRoom || selectedRoom.environmentalSystems === true}
                  onClick={() =>
                    selectedRoom &&
                    void issue(
                      "environmental_systems",
                      selectedRoom.id,
                      true,
                      `Enable climate control in ${selectedRoom.id}`,
                    )
                  }
                >
                  Climate on
                </button>
                <ConfirmButton
                  label="Climate off"
                  impact={`Disabling climate control in ${titleCase(
                    selectedRoom?.id ?? "this room",
                  )} stops active temperature, humidity and ventilation regulation — the room then only drifts with its neighbours and the hull. Use it for maintenance or to isolate a fault, never to save power during a mission.`}
                  confirmLabel="Disable climate control"
                  disabled={pending !== null || !selectedRoom || selectedRoom.environmentalSystems === false}
                  className="btn btn-warn col-span-1"
                  onConfirm={() =>
                    selectedRoom &&
                    void issue(
                      "environmental_systems",
                      selectedRoom.id,
                      false,
                      `Disable climate control in ${selectedRoom.id}`,
                    )
                  }
                />
                <ConfirmButton
                  label="Seal room"
                  impact={`Sealing ${titleCase(
                    selectedRoom?.id ?? "this room",
                  )} closes it off from the habitat air loop: no ventilation, no crew movement, and the room's CO₂ and humidity readings will keep climbing while it is sealed. Unseal it before anyone enters again.`}
                  confirmLabel="Seal the room"
                  disabled={pending !== null || !selectedRoom || selectedRoom.sealed === true}
                  className="btn col-span-1"
                  onConfirm={() =>
                    selectedRoom &&
                    void issue("seal_room", selectedRoom.id, true, `Seal ${selectedRoom.id}`)
                  }
                />
                <button
                  type="button"
                  className="btn col-span-1"
                  disabled={pending !== null || !selectedRoom || selectedRoom.sealed !== true}
                  onClick={() =>
                    selectedRoom &&
                    void issue("seal_room", selectedRoom.id, false, `Unseal ${selectedRoom.id}`)
                  }
                >
                  Unseal room
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <ConfirmButton
                  label="Pressurise airlock"
                  impact={`The airlock is currently ${
                    airlockState ?? "in an unknown state"
                  }. Pressurising admits habitat air into the lock so the inner door can open — it must finish before anyone leaves the EVA prep area.`}
                  confirmLabel="Pressurise the lock"
                  disabled={pending !== null || airlockState === "pressurised" || airlockState === "cycling"}
                  className="btn col-span-1"
                  onConfirm={() =>
                    void issue("cycle_airlock", "airlock", "pressurise", "Pressurise airlock")
                  }
                />
                <ConfirmButton
                  label="Depressurise airlock"
                  impact={`The airlock is currently ${
                    airlockState ?? "in an unknown state"
                  }. Depressurising vents the lock to vacuum so the outer door can open; anyone inside without a suit would not survive the cycle, and the habitat loses that air volume.`}
                  confirmLabel="Depressurise the lock"
                  disabled={pending !== null || airlockState === "depressurised" || airlockState === "cycling"}
                  className="btn btn-danger col-span-1"
                  onConfirm={() =>
                    void issue("cycle_airlock", "airlock", "depressurise", "Depressurise airlock")
                  }
                />
                <button
                  type="button"
                  className="btn col-span-2"
                  disabled={pending !== null}
                  onClick={() =>
                    void issue(
                      "crew_wellness_check",
                      crew[0]?.id ?? "crew-1",
                      true,
                      `Wellness check ${crew[0]?.id ?? "crew-1"}`,
                    )
                  }
                >
                  Wellness check ({crew[0]?.id ?? "crew-1"})
                </button>
                <p className="col-span-2 text-[10px] uppercase tracking-[0.12em] text-console-muted">
                  airlock {airlockState ?? "unknown"}
                </p>
              </div>

              {isHydroponics && (
                <div className="rounded-lg border border-console-edge/70 bg-console-void/40 px-3 py-2">
                  <span className="label">Irrigation schedule</span>
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      aria-label="Irrigation window start"
                      className="input"
                      value={irrigationStart}
                      onChange={(event) => setIrrigationStart(event.target.value)}
                      placeholder="06:00"
                    />
                    <input
                      aria-label="Irrigation window end"
                      className="input"
                      value={irrigationEnd}
                      onChange={(event) => setIrrigationEnd(event.target.value)}
                      placeholder="06:30"
                    />
                    <input
                      aria-label="Irrigation volume (litres)"
                      className="input"
                      inputMode="decimal"
                      value={irrigationVolume}
                      onChange={(event) => setIrrigationVolume(event.target.value)}
                      placeholder="40 L"
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary mt-2 w-full"
                    disabled={
                      pending !== null ||
                      !Number.isFinite(Number(irrigationVolume)) ||
                      Number(irrigationVolume) < 0 ||
                      Number(irrigationVolume) > 500
                    }
                    onClick={() =>
                      void issue(
                        "irrigation_schedule",
                        "hydroponics",
                        {
                          start: irrigationStart,
                          end: irrigationEnd,
                          volume_l: Number(irrigationVolume),
                        },
                        `Irrigate hydroponics ${irrigationStart}–${irrigationEnd} with ${irrigationVolume} L`,
                      )
                    }
                  >
                    Apply irrigation schedule
                  </button>
                  <p className="mt-1 text-[10px] text-console-muted">
                    Window and volume (0–500 L) are published together; the crop day preset uses this.
                  </p>
                </div>
              )}

              {feedback && (
                <p
                  className={`rounded-md border px-2.5 py-1.5 text-[11px] ${
                    feedback.tone === "ok"
                      ? "border-console-ok/40 bg-console-ok/10 text-console-ok"
                      : "border-console-alert/50 bg-console-alert/10 text-console-alert"
                  }`}
                >
                  {feedback.text}
                </p>
              )}
            </div>
          </Panel>

          <Panel title="Habitat status" subtitle="Aggregated life-support and mission state.">
            <div className="grid grid-cols-2 gap-2">
              <Metric label="Mode" value={habitat?.mode ? titleCase(String(habitat.mode)) : "—"} />
              <Metric
                label="Mission day"
                value={typeof habitat?.missionDay === "number" ? habitat.missionDay : "—"}
              />
              <Metric
                label="Peak CO₂"
                value={roomSummary.maxCo2Ppm !== null ? Math.round(roomSummary.maxCo2Ppm) : "—"}
                unit="ppm"
                tone={
                  roomSummary.maxCo2Ppm !== null && roomSummary.maxCo2Ppm >= MHE_CO2_LIMIT_PPM
                    ? "alert"
                    : "ok"
                }
              />
              <Metric
                label="Max heart rate"
                value={crewSummary.maxHeartRate !== null ? Math.round(crewSummary.maxHeartRate) : "—"}
                unit="bpm"
                tone={
                  crewSummary.maxHeartRate !== null && crewSummary.maxHeartRate >= MHE_HEART_RATE_LIMIT_BPM
                    ? "alert"
                    : "neutral"
                }
              />
              <Metric label="Crew onboard" value={roomSummary.crewOnboard} />
              <Metric label="Surveys (12h)" value={`${crewSummary.surveysRecent}/5`} />
            </div>
            <p className="mt-2 text-[10px] uppercase tracking-[0.12em] text-console-muted">
              {mode === "replay" ? "Snapshot from replay cursor" : "Live SSE feed"}
            </p>
          </Panel>

          <AlertAnnunciator title="MHE alerts" maxHeight="max-h-[420px]" />
        </div>
      </div>
    </div>
  );
}
