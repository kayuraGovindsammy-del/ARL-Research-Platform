"use client";

import { useEffect, useMemo, useState } from "react";
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
import {
  MHE_CO2_LIMIT_PPM,
  MHE_HEART_RATE_LIMIT_BPM,
  type MheCrewSurvey,
} from "@/lib/types";
import { useCommandRunner } from "@/lib/use-command";
import { useNow } from "@/lib/use-now";
import { useOperator } from "@/lib/use-operator";
import { AlertAnnunciator } from "../AlertAnnunciator";
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
  const [lightDraft, setLightDraft] = useState(800);
  const [lightWindowStart, setLightWindowStart] = useState("06:00");
  const [lightWindowEnd, setLightWindowEnd] = useState("22:00");

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

  useEffect(() => {
    if (!selectedRoom?.telemetry) return;
    if (typeof selectedRoom.telemetry.temperatureC === "number") {
      setTemperatureDraft(selectedRoom.telemetry.temperatureC.toFixed(1));
    }
    if (typeof selectedRoom.telemetry.lightingLux === "number") {
      setLightDraft(Math.round(selectedRoom.telemetry.lightingLux));
    }
  }, [selectedRoom?.id, selectedRoom?.telemetry]);

  /** Hydroponics runs grow lights an order of magnitude brighter than the rest. */
  const lightMaxLux = selectedRoom?.id === "hydroponics" ? 30000 : 1000;

  const issue = (control: string, entity: string, value: unknown, label: string) =>
    run({ service: "MHE", entity, control, value, researcher: operator }, label);

  const surveyScore = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 1), 10) : null;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-console-signal">
            Service 02 · Mars Habitation Experiment
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-console-ink">
            9-room habitat & crew wellbeing
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-console-muted">
            Room environment every 5 minutes, crew vitals every minute, surveys twice per mission day.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">{habitat?.mode ? titleCase(String(habitat.mode)) : "habitat"}</Badge>
          <Badge tone="neutral">
            day {typeof habitat?.missionDay === "number" ? habitat.missionDay : "—"}
          </Badge>
          <Badge tone="neutral">{roomSummary.crewOnboard} crew onboard</Badge>
          <Badge tone="neutral">last telemetry {lastTelemetryAt ? timeAgo(lastTelemetryAt, now) : "—"}</Badge>
          {mode === "replay" && <Badge tone="warn">historical view</Badge>}
        </div>
      </header>

      <ReplayBar service="MHE" />

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
                  disabled={pending !== null}
                  onClick={() =>
                    void issue("cycle_airlock", "airlock", "pressurise", "Pressurise airlock")
                  }
                >
                  Pressurize airlock
                </button>
                <button
                  type="button"
                  className="btn col-span-1"
                  disabled={pending !== null}
                  onClick={() =>
                    void issue(
                      "cycle_airlock",
                      "airlock",
                      "depressurise",
                      "Depressurise airlock",
                    )
                  }
                >
                  Depressurize airlock
                </button>
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
              </div>

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
