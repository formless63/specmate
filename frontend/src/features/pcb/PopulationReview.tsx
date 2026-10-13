import { Alert, Badge, Button, Group, Select, Stack, Table, Text, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import {
  getPopulationDraftReview, getPopulationRevisionReview, PcbRequestError,
  type FrozenPopulationReview, type PopulationReview,
} from "./api";

type Props = {
  kind: "draft" | "revision"; id: string;
  onAccessLost: (reason: unknown) => void;
};

const PAGE_SIZE = 25;

export function PopulationReviewPanel({ kind, id, onAccessLost }: Props) {
  const accessLost = useRef(onAccessLost);
  accessLost.current = onAccessLost;
  const [review, setReview] = useState<PopulationReview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let sequence = 0;
    const refresh = () => {
      const current = ++sequence;
      setReview(null); setError("");
      const read = kind === "revision"
        ? getPopulationRevisionReview(id, controller.signal)
        : getPopulationDraftReview(id, controller.signal);
      read.then((result) => {
        if (!controller.signal.aborted && current === sequence) setReview(result);
      }).catch((reason) => {
        if (controller.signal.aborted || current !== sequence) return;
        setReview(null);
        setError(reason instanceof Error ? reason.message : "Population review unavailable.");
        if (reason instanceof PcbRequestError && [401, 403, 404].includes(reason.status)) {
          accessLost.current(reason);
        }
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, [kind, id]);

  if (error) return <Alert color="red" role="alert">{error}</Alert>;
  if (!review) return <Text>Loading authorized population review…</Text>;
  return <Readout key={`${kind}:${id}`} review={review} kind={kind} />;
}

function Readout({ review, kind }: { review: PopulationReview; kind: Props["kind"] }) {
  const [optionId, setOptionId] = useState<string | null>(null);
  const [componentPage, setComponentPage] = useState(0);
  const [associationPage, setAssociationPage] = useState(0);
  const option = review.population.options.find((item) => item.local_id === optionId)
    ?? review.population.options[0];
  const decisionByComponent = new Map(option?.decisions.map((item) => [item.component_id, item]));
  const componentRows = review.report.components.slice(
    componentPage * PAGE_SIZE, (componentPage + 1) * PAGE_SIZE
  );
  const associationRows = review.associations.slice(
    associationPage * PAGE_SIZE, (associationPage + 1) * PAGE_SIZE
  );
  const frozen = kind === "revision" ? review as FrozenPopulationReview : null;

  return <Stack>
    <Title order={4}>{frozen ? `Frozen population revision #${frozen.number}` : "Current draft review"}</Title>
    {frozen && <><Text size="sm">Revision {frozen.revision_id} · frozen {frozen.frozen_at}</Text>
      <Text size="xs">Snapshot {frozen.snapshot_id} · SHA-256 {frozen.snapshot_sha256}</Text></>}
    <Text size="sm">Accepted interpretation {review.interpretation.interpretation_id} · SHA-256 {review.interpretation.sha256}</Text>
    <Text size="xs">Native output {review.interpretation.output_id} · extraction {review.interpretation.attempt_id}</Text>
    <Text size="xs">Original board {review.interpretation.board_path} · source revision {review.interpretation.source_revision_id} · manifest SHA-256 {review.interpretation.source_manifest_sha256}</Text>
    <Text size="xs">Native board SHA-256 {review.report.source_sha256}</Text>
    <Group><Badge>{review.population.options.length} options</Badge><Badge>{review.associations.length} association records</Badge></Group>
    <Select label={frozen ? "Option in frozen revision" : "Option in current draft"}
      value={option?.local_id ?? null}
      data={review.population.options.map((item) => ({ value: item.local_id, label: item.name }))}
      onChange={(value) => { setOptionId(value); setComponentPage(0); }} />
    {option && <><Table><Table.Thead><Table.Tr>
      <Table.Th>Native component</Table.Th><Table.Th>Source DNP</Table.Th>
      <Table.Th>Option decision</Table.Th><Table.Th>Basis</Table.Th>
    </Table.Tr></Table.Thead><Table.Tbody>
      {componentRows.map((component) => {
        const decision = decisionByComponent.get(component.id);
        return <Table.Tr key={component.id}>
          <Table.Td>{component.reference}<Text size="xs">{component.id}</Text></Table.Td>
          <Table.Td>{component.dnp ? "Set" : "Unset"}</Table.Td>
          <Table.Td>{decision?.status === "populate" ? "Populate" : decision?.status === "omit" ? "Omit" : "Unresolved"}</Table.Td>
          <Table.Td>{decision?.basis ?? "—"}</Table.Td>
        </Table.Tr>;
      })}
    </Table.Tbody></Table>
      <Pager page={componentPage} total={review.report.components.length} onChange={setComponentPage} label="Components" />
    </>}
    <Title order={5}>Recorded associations</Title>
    {review.associations.length === 0 && <Text>No association candidates recorded.</Text>}
    {!!review.associations.length && <><Table><Table.Thead><Table.Tr>
      <Table.Th>Native anchor</Table.Th><Table.Th>Exact target</Table.Th>
      <Table.Th>Review</Table.Th><Table.Th>Evidence</Table.Th>
    </Table.Tr></Table.Thead><Table.Tbody>
      {associationRows.map(({ association, target }) => {
        const component = review.report.components.find((item) => item.id === association.component_id);
        const pad = review.report.pads.find((item) => item.id === association.pad_id);
        return <Table.Tr key={association.local_id}>
          <Table.Td><Text>{association.kind} · {component?.reference ?? "Unknown component"}</Text>
            <Text size="xs">Component {association.component_id}</Text>
            {association.pad_id && <Text size="xs">Pad {pad?.terminal ?? "Unknown"} · {association.pad_id}</Text>}
          </Table.Td>
          <Table.Td><Text>{target.definition_name} · {target.definition_kind}{target.revision_number ? ` #${target.revision_number}` : ""}</Text>
            <Text size="xs">Revision {target.revision_id}</Text>
            {association.target_contact_id && <Text size="xs">Body contact {association.target_contact_id}</Text>}
            {target.representation_id && <><Text size="xs">Model {target.representation_label} · {target.representation_id}</Text>
              <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>Model source {target.source_path} · revision {target.source_revision_id}</Text>
              <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>SHA-256 {target.source_sha256} · rights {target.source_rights}</Text></>}
          </Table.Td>
          <Table.Td><Badge>{association.review}</Badge>
            <Text size="xs">{association.basis ?? "Awaiting review"}</Text></Table.Td>
          <Table.Td>{association.evidence?.kind === "citation"
            ? <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>Citation: {association.evidence.citation}</Text>
            : association.evidence?.kind === "source_file"
              ? <Stack gap={0}><Text size="xs" style={{ whiteSpace: "pre-wrap" }}>File {association.evidence.path} · revision {association.evidence.source_revision_id}</Text>
                <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>SHA-256 {association.evidence.sha256} · rights {association.evidence.rights}</Text></Stack>
              : <Text size="xs">No evidence filed</Text>}
          </Table.Td>
        </Table.Tr>;
      })}
    </Table.Tbody></Table>
      <Pager page={associationPage} total={review.associations.length} onChange={setAssociationPage} label="Associations" />
    </>}
    <Text size="xs">A reviewed association records a match decision. It does not establish compatibility, model accuracy or manufacturing approval.</Text>
  </Stack>;
}

function Pager({ page, total, onChange, label }: {
  page: number; total: number; onChange: (page: number) => void; label: string;
}) {
  if (total <= PAGE_SIZE) return null;
  const pages = Math.ceil(total / PAGE_SIZE);
  return <Group><Button size="xs" variant="subtle" disabled={page === 0} onClick={() => onChange(page - 1)}>Previous {label.toLowerCase()}</Button>
    <Text size="xs">{label} page {page + 1} of {pages}</Text>
    <Button size="xs" variant="subtle" disabled={page >= pages - 1} onClick={() => onChange(page + 1)}>Next {label.toLowerCase()}</Button></Group>;
}
