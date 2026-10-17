import "./connect.css";

/** Under the colony's name in the top bar: the connect page for this colony, and its SKILL.md to save. */
export function ConnectLinks({ colonyId }: { colonyId: string }) {
  const id = encodeURIComponent(colonyId);
  return (
    <div className="brand-connect">
      <a href={`/connect?colony=${id}`} title="Connect your agent to this colony: one copy-paste per client">
        Connect an agent
      </a>
      <span aria-hidden="true">·</span>
      <a href={`/api/colonies/${id}/skill`} download="SKILL.md" title="How an agent works in this colony, as a skill file">
        SKILL.md
      </a>
    </div>
  );
}
