import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const FALLBACK_BACKLOG_PATH = path.join(os.homedir(), "wiki/backlog.md");

// PI_BACKLOG_PATH overrides the default; a leading "~" is expanded.
export function getBacklogPath(): string {
  const env = process.env.PI_BACKLOG_PATH?.trim();
  if (!env) return FALLBACK_BACKLOG_PATH;
  return path.resolve(env.replace(/^~(?=$|\/)/, os.homedir()));
}

// Subtasks are indented checkbox lines directly under a task:
//   - [ ] **Parent** <!-- id: parent -->
//     - [x] First step
//     - [ ] Second step
// Subtasks are addressed by 1-based number or by title (exact, then unique substring).
// A subtask may carry a trailing tag naming the subtasks (1-based positions in the same task)
// that must be done first:  "  - [ ] Title [blocked-by: 3, 4]"
// A subtask may also carry detail lines: bullets indented 4+ spaces directly under it.
//   - [ ] Title
//     - Acceptance criterion
export interface BacklogSubtask {
  title: string;
  done: boolean;
  blockedBy: number[];
  // Plain text per detail line, without indentation or bullet.
  details: string[];
}

export interface SubtaskState {
  // Open (not done) subtasks that still block this one.
  openBlockers: number[];
  // Referenced positions that do not exist (stale reference).
  unknownBlockers: number[];
  // Not done and waiting on something.
  blocked: boolean;
}

// Normalise detail input to plain text lines: drop indentation, a leading "- " bullet and blanks.
export function cleanSubtaskDetails(lines: string[] | undefined): string[] {
  return (lines ?? []).map((l) => l.trim().replace(/^[-*]\s+/, "").trim()).filter((l) => l.length > 0);
}

const BLOCKED_BY_TAG = /\s*\[blocked-by:\s*([\d\s,]*)\]\s*$/i;

// Split "Title [blocked-by: 3, 4]" into title and sorted unique blocker numbers.
export function parseSubtaskText(raw: string): { title: string; blockedBy: number[] } {
  const text = raw.trim();
  const match = text.match(BLOCKED_BY_TAG);
  if (!match) return { title: text, blockedBy: [] };
  const numbers = match[1]
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1);
  return {
    title: text.replace(BLOCKED_BY_TAG, "").trim(),
    blockedBy: Array.from(new Set(numbers)).sort((a, b) => a - b),
  };
}

// Text shown when editing a subtask: title plus its blocked-by tag.
export function subtaskEditText(sub: BacklogSubtask): string {
  return sub.blockedBy.length > 0 ? `${sub.title} [blocked-by: ${sub.blockedBy.join(", ")}]` : sub.title;
}

// Derived at read time from the current done flags, never stored.
export function subtaskState(task: BacklogTask, index: number): SubtaskState {
  const sub = task.subtasks[index];
  const openBlockers: number[] = [];
  const unknownBlockers: number[] = [];
  for (const n of sub.blockedBy) {
    const blocker = task.subtasks[n - 1];
    if (!blocker || n - 1 === index) unknownBlockers.push(n);
    else if (!blocker.done) openBlockers.push(n);
  }
  return {
    openBlockers,
    unknownBlockers,
    blocked: !sub.done && (openBlockers.length > 0 || unknownBlockers.length > 0),
  };
}

export interface BacklogTask {
  id: string;
  title: string;
  section: string;
  done: boolean;
  priority?: "high" | "med" | "low";
  ticket?: string;
  tags: string[];
  meta: Record<string, string>;
  subtasks: BacklogSubtask[];
  details: string[];
  rawLineIndex: number;
  rawEndLineIndex: number;
}

export interface BacklogDocument {
  frontmatter: string;
  header: string[];
  sections: string[];
  tasks: BacklogTask[];
  sectionNotes: Record<string, string[]>; // Non-task text in sections (e.g. Intake rule)
  rawLines: string[];
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 50);
}

// Local time in Europe/Helsinki with UTC offset, e.g. 2026-11-06T10:19+02:00
export function helsinkiTimestamp(date: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const offset = (parts.timeZoneName ?? "").replace(/^GMT/, "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}${offset}`;
}

export function subtaskProgress(task: BacklogTask): { done: number; total: number } {
  return {
    done: task.subtasks.filter((s) => s.done).length,
    total: task.subtasks.length,
  };
}

export function parseBacklog(content: string): BacklogDocument {
  const lines = content.split("\n");
  let frontmatter = "";
  let i = 0;

  if (lines[0]?.trim() === "---") {
    let fmEnd = -1;
    for (let j = 1; j < lines.length; j++) {
      if (lines[j]?.trim() === "---") {
        fmEnd = j;
        break;
      }
    }
    if (fmEnd !== -1) {
      frontmatter = lines.slice(0, fmEnd + 1).join("\n");
      i = fmEnd + 1;
    }
  }

  const header: string[] = [];
  const sections: string[] = [];
  const tasks: BacklogTask[] = [];
  const sectionNotes: Record<string, string[]> = {};
  let currentSection = "General";
  let inSections = false;
  let inDone = false;

  const sectionRegex = /^##\s+(.+)$/;
  const taskRegex = /^\s*-\s*\[([ xX])\]\s*(.+)$/;
  const subtaskRegex = /^\s{2,}-\s*\[([ xX])\]\s*(.+)$/;
  const idCommentRegex = /<!--\s*id:\s*([a-zA-Z0-9_-]+)\s*-->/;
  const metaBracketRegex = /\[([a-zA-Z0-9_-]+):\s*([^\]]+)\]/g;
  const boldTitleRegex = /^\*\*([^*]+)\*\*(.*)$/;

  while (i < lines.length) {
    const line = lines[i];

    const sectionMatch = line.match(sectionRegex);
    if (sectionMatch) {
      inSections = true;
      const heading = sectionMatch[1].trim();
      inDone = heading === DONE_SECTION;
      currentSection = inDone ? "General" : heading;
      if (!inDone && !sections.includes(currentSection)) {
        sections.push(currentSection);
      }
      i++;
      continue;
    }

    const doneSubMatch = inDone ? line.match(/^###\s+(.+)$/) : null;
    if (doneSubMatch) {
      currentSection = doneSubMatch[1].trim();
      if (!sections.includes(currentSection)) {
        sections.push(currentSection);
      }
      i++;
      continue;
    }

    if (!inSections && !line.match(taskRegex)) {
      header.push(line);
      i++;
      continue;
    }

    const taskMatch = line.match(taskRegex);
    if (taskMatch) {
      inSections = true;
      const done = taskMatch[1].toLowerCase() === "x";
      let rest = taskMatch[2].trim();

      let id = "";
      const idMatch = rest.match(idCommentRegex);
      if (idMatch) {
        id = idMatch[1];
        rest = rest.replace(idCommentRegex, "").trim();
      }

      const meta: Record<string, string> = {};
      const tags: string[] = [];
      let priority: "high" | "med" | "low" | undefined;
      let ticket: string | undefined;

      const metaMatches = Array.from(rest.matchAll(metaBracketRegex));
      for (const m of metaMatches) {
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        meta[key] = val;
        if (key === "priority" && ["high", "med", "low"].includes(val.toLowerCase())) {
          priority = val.toLowerCase() as "high" | "med" | "low";
        } else if (key === "ticket") {
          ticket = val;
        } else if (key === "tag") {
          tags.push(val);
        }
      }

      let titleClean = rest.replace(metaBracketRegex, "").trim();

      let title = titleClean;
      const boldMatch = titleClean.match(boldTitleRegex);
      if (boldMatch) {
        title = boldMatch[1].trim();
        const suffix = boldMatch[2].trim();
        if (suffix) {
          const ticketLinkMatch = suffix.match(/\[([A-Z]+-\d+)\]/);
          if (ticketLinkMatch && !ticket) {
            ticket = ticketLinkMatch[1];
          }
        }
      } else {
        title = titleClean.replace(/^\*\*|\*\*$/g, "").trim();
      }

      if (!id) {
        id = slugify(title);
      }

      const startIndex = i;
      const details: string[] = [];
      const subtasks: BacklogSubtask[] = [];
      // True while the lines read belong to the last subtask (the subtask line or its details).
      let inSubtask = false;
      i++;

      // Indented block under the task: subtask checkboxes and free-text details.
      // Stops at a section heading or a non-indented line.
      while (i < lines.length) {
        const nextLine = lines[i];
        const subtaskMatch = nextLine.match(subtaskRegex);
        if (subtaskMatch) {
          subtasks.push({ ...parseSubtaskText(subtaskMatch[2]), done: subtaskMatch[1].toLowerCase() === "x", details: [] });
          inSubtask = true;
          i++;
          continue;
        }
        if (inSubtask && /^\s{4,}\S/.test(nextLine)) {
          subtasks[subtasks.length - 1].details.push(...cleanSubtaskDetails([nextLine]));
          i++;
          continue;
        }
        if (nextLine.match(sectionRegex)) {
          break;
        }
        inSubtask = false;
        if (/^\s{2,}/.test(nextLine) || (nextLine.trim() === "" && i + 1 < lines.length && /^\s{2,}/.test(lines[i + 1]))) {
          details.push(nextLine);
          i++;
        } else {
          break;
        }
      }

      const endIndex = i - 1;

      tasks.push({
        id,
        title,
        section: currentSection,
        done,
        priority,
        ticket,
        tags,
        meta,
        subtasks,
        details,
        rawLineIndex: startIndex,
        rawEndLineIndex: endIndex,
      });
      continue;
    }

    // Section notes (e.g. text under ## Intake rule)
    if (inSections && line.trim() !== "") {
      if (!sectionNotes[currentSection]) {
        sectionNotes[currentSection] = [];
      }
      sectionNotes[currentSection].push(line);
    }

    i++;
  }

  return {
    frontmatter,
    header,
    sections,
    tasks,
    sectionNotes,
    rawLines: lines,
  };
}

// Heading of the trailing archive section; its "### X" subheadings name each task's real section.
export const DONE_SECTION = "Done";

export function formatTask(task: BacklogTask): string[] {
  const check = task.done ? "[x]" : "[ ]";
  const idComment = `<!-- id: ${task.id} -->`;

  const metaParts: string[] = [];
  if (task.priority) metaParts.push(`[priority: ${task.priority}]`);
  if (task.ticket) metaParts.push(`[ticket: ${task.ticket}]`);
  for (const tag of task.tags) {
    metaParts.push(`[tag: ${tag}]`);
  }
  for (const [k, v] of Object.entries(task.meta)) {
    if (!["priority", "ticket", "tag"].includes(k)) {
      metaParts.push(`[${k}: ${v}]`);
    }
  }

  const metaStr = metaParts.length > 0 ? " " + metaParts.join(" ") : "";
  const taskHeader = `- ${check} **${task.title}** ${idComment}${metaStr}`;

  const lines = [taskHeader];
  for (const s of task.subtasks ?? []) {
    const tag = s.blockedBy?.length ? ` [blocked-by: ${s.blockedBy.join(", ")}]` : "";
    lines.push(`  - ${s.done ? "[x]" : "[ ]"} ${s.title}${tag}`);
    for (const d of s.details ?? []) lines.push(`    - ${d}`);
  }
  if (task.details && task.details.length > 0) {
    for (const d of task.details) {
      lines.push(d);
    }
  }
  return lines;
}

export function serializeBacklog(doc: BacklogDocument): string {
  const out: string[] = [];

  if (doc.frontmatter) {
    out.push(doc.frontmatter);
    out.push("");
  }

  if (doc.header.length > 0) {
    out.push(doc.header.join("\n").trim());
    out.push("");
  }

  for (const section of doc.sections) {
    out.push(`## ${section}`);
    out.push("");

    const sectionTasks = doc.tasks.filter((t) => t.section === section && !t.done);
    for (const task of sectionTasks) {
      out.push(...formatTask(task));
      out.push("");
    }

    const notes = doc.sectionNotes[section];
    if (notes && notes.length > 0) {
      out.push(notes.join("\n").trim());
      out.push("");
    }
  }

  const doneBySection = doc.sections
    .map((section) => ({ section, tasks: doc.tasks.filter((t) => t.section === section && t.done) }))
    .filter((g) => g.tasks.length > 0);
  if (doneBySection.length > 0) {
    out.push(`## ${DONE_SECTION}`);
    out.push("");
    for (const { section, tasks } of doneBySection) {
      out.push(`### ${section}`);
      out.push("");
      for (const task of tasks) {
        out.push(...formatTask(task));
        out.push("");
      }
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// Resolve a subtask reference: 1-based number, exact title, or unique title substring.
// Returns index, or -1 when not found, -2 when ambiguous.
export function resolveSubtaskIndex(task: BacklogTask, ref: string): number {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n >= 1 && n <= task.subtasks.length ? n - 1 : -1;
  }
  const lower = trimmed.toLowerCase();
  const exact = task.subtasks.findIndex((s) => s.title.toLowerCase() === lower);
  if (exact !== -1) return exact;
  const matches = task.subtasks
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => s.title.toLowerCase().includes(lower));
  if (matches.length === 1) return matches[0].idx;
  return matches.length > 1 ? -2 : -1;
}

// Helper CRUD operations
export class BacklogManager {
  private filePath: string;
  private doc: BacklogDocument;

  constructor(filePath: string = getBacklogPath()) {
    this.filePath = filePath;
    this.doc = parseBacklog(this.read());
  }

  private read(): string {
    if (!fs.existsSync(this.filePath)) return "# Backlog\n\n";
    return fs.readFileSync(this.filePath, "utf-8");
  }

  private save(): void {
    const serialized = serializeBacklog(this.doc);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, serialized, "utf-8");
  }

  public get path(): string {
    return this.filePath;
  }

  public reload(): void {
    this.doc = parseBacklog(this.read());
  }

  public getTasks(filter?: { section?: string; done?: boolean; tag?: string; query?: string }): BacklogTask[] {
    return this.doc.tasks.filter((t) => {
      if (filter?.section && t.section.toLowerCase() !== filter.section.toLowerCase()) return false;
      if (filter?.done !== undefined && t.done !== filter.done) return false;
      if (filter?.tag && !t.tags.includes(filter.tag)) return false;
      if (filter?.query) {
        const q = filter.query.toLowerCase();
        const inTitle = t.title.toLowerCase().includes(q);
        const inDetails = t.details.some((d) => d.toLowerCase().includes(q));
        const inSubtasks = t.subtasks.some(
          (s) => s.title.toLowerCase().includes(q) || s.details.some((d) => d.toLowerCase().includes(q))
        );
        const inTicket = t.ticket?.toLowerCase().includes(q);
        if (!inTitle && !inDetails && !inSubtasks && !inTicket) return false;
      }
      return true;
    });
  }

  public getTask(id: string): BacklogTask | undefined {
    return this.doc.tasks.find((t) => t.id === id);
  }

  public addTask(taskData: {
    title: string;
    section: string;
    details?: string[];
    subtasks?: string[];
    priority?: "high" | "med" | "low";
    ticket?: string;
    tags?: string[];
    meta?: Record<string, string>;
  }): BacklogTask {
    const id = slugify(taskData.title);
    if (!this.doc.sections.includes(taskData.section)) {
      this.doc.sections.push(taskData.section);
    }

    const newTask: BacklogTask = {
      id,
      title: taskData.title,
      section: taskData.section,
      done: false,
      priority: taskData.priority,
      ticket: taskData.ticket,
      tags: taskData.tags || [],
      meta: { created: helsinkiTimestamp(), ...(taskData.meta || {}) },
      subtasks: (taskData.subtasks || [])
        .map((s) => ({ ...parseSubtaskText(s), done: false, details: [] }))
        .filter((s) => s.title),
      details: taskData.details ? taskData.details.map(d => d.startsWith(" ") ? d : `  - ${d}`) : [],
      rawLineIndex: -1,
      rawEndLineIndex: -1,
    };

    this.doc.tasks.push(newTask);
    this.save();
    return newTask;
  }

  public updateTask(
    id: string,
    updates: {
      title?: string;
      done?: boolean;
      section?: string;
      priority?: "high" | "med" | "low";
      ticket?: string;
      details?: string[];
      tags?: string[];
    }
  ): BacklogTask | null {
    const task = this.doc.tasks.find((t) => t.id === id);
    if (!task) return null;

    const completionChanged = updates.done !== undefined && updates.done !== task.done;

    if (updates.title !== undefined) task.title = updates.title;
    if (updates.done !== undefined) task.done = updates.done;
    if (updates.section !== undefined) {
      task.section = updates.section;
      if (!this.doc.sections.includes(updates.section)) {
        this.doc.sections.push(updates.section);
      }
    }
    if (completionChanged) {
      if (task.done) {
        task.meta.done = helsinkiTimestamp();
      } else {
        delete task.meta.done;
      }
      this.placeTask(task);
    }
    if (updates.priority !== undefined) task.priority = updates.priority;
    if (updates.ticket !== undefined) task.ticket = updates.ticket;
    if (updates.tags !== undefined) task.tags = updates.tags;
    if (updates.details !== undefined) {
      task.details = updates.details.map(d => d.startsWith(" ") ? d : `  - ${d}`);
    }

    this.save();
    return task;
  }

  // Subtask CRUD. Throws Error with a readable message on bad input.
  // blockedBy: positions of subtasks that must be done first. A "[blocked-by: n]" tag in the
  // title is also accepted; explicit blockedBy wins.
  public addSubtask(taskId: string, title: string, blockedBy?: number[], details?: string[]): BacklogSubtask {
    const task = this.requireTask(taskId);
    const parsed = parseSubtaskText(title);
    if (!parsed.title) throw new Error("Subtask title is required.");
    const blockers = this.cleanBlockers(task, blockedBy ?? parsed.blockedBy, task.subtasks.length);
    const sub: BacklogSubtask = { title: parsed.title, done: false, blockedBy: blockers, details: cleanSubtaskDetails(details) };
    task.subtasks.push(sub);
    this.save();
    return sub;
  }

  public updateSubtask(
    taskId: string,
    ref: string,
    updates: { title?: string; done?: boolean; blockedBy?: number[]; details?: string[] }
  ): BacklogSubtask {
    const task = this.requireTask(taskId);
    const index = this.requireSubtaskIndex(task, ref);
    const sub = task.subtasks[index];
    let blockedBy = updates.blockedBy;
    if (updates.title !== undefined) {
      const parsed = parseSubtaskText(updates.title);
      if (!parsed.title) throw new Error("Subtask title is required.");
      sub.title = parsed.title;
      // A tag typed into the title replaces the blockers; a plain title keeps them.
      if (blockedBy === undefined && BLOCKED_BY_TAG.test(updates.title.trim())) blockedBy = parsed.blockedBy;
    }
    if (blockedBy !== undefined) sub.blockedBy = this.cleanBlockers(task, blockedBy, task.subtasks.length, index + 1);
    if (updates.done !== undefined) sub.done = updates.done;
    // Details replace the existing ones; an empty array clears them.
    if (updates.details !== undefined) sub.details = cleanSubtaskDetails(updates.details);
    this.save();
    return sub;
  }

  public deleteSubtask(taskId: string, ref: string): BacklogSubtask {
    const task = this.requireTask(taskId);
    const index = this.requireSubtaskIndex(task, ref);
    const [removed] = task.subtasks.splice(index, 1);
    // Positions after the removed one shift down by one; references to it are dropped.
    const removedNumber = index + 1;
    for (const sub of task.subtasks) {
      sub.blockedBy = sub.blockedBy
        .filter((n) => n !== removedNumber)
        .map((n) => (n > removedNumber ? n - 1 : n));
    }
    this.save();
    return removed;
  }

  // Validate blocker positions: whole numbers within 1..max, not the subtask itself.
  private cleanBlockers(task: BacklogTask, numbers: number[], max: number, self?: number): number[] {
    const unique = Array.from(new Set(numbers));
    for (const n of unique) {
      if (!Number.isInteger(n) || n < 1 || n > max) {
        throw new Error(`Blocker ${n} does not exist in '${task.id}' (valid: 1-${max}).`);
      }
      if (n === self) throw new Error(`Subtask ${n} cannot block itself.`);
    }
    return unique.sort((a, b) => a - b);
  }

  // Index of subtask for TUI/CLI use; -1 not found, -2 ambiguous.
  public findSubtaskIndex(taskId: string, ref: string): number {
    const task = this.getTask(taskId);
    return task ? resolveSubtaskIndex(task, ref) : -1;
  }

  private requireTask(taskId: string): BacklogTask {
    const task = this.doc.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task '${taskId}' not found.`);
    return task;
  }

  private requireSubtaskIndex(task: BacklogTask, ref: string): number {
    const idx = resolveSubtaskIndex(task, ref);
    if (idx === -1) throw new Error(`Subtask '${ref}' not found in '${task.id}'.`);
    if (idx === -2) throw new Error(`Subtask '${ref}' is ambiguous in '${task.id}'. Use its number.`);
    return idx;
  }

  // Keep open tasks first, done tasks last within each section.
  // Completed tasks go to the section bottom; reopened tasks go back above the done block.
  private placeTask(task: BacklogTask): void {
    const idx = this.doc.tasks.indexOf(task);
    this.doc.tasks.splice(idx, 1);

    const sectionIdxs = this.doc.tasks
      .map((t, i) => (t.section === task.section ? i : -1))
      .filter((i) => i !== -1);

    let insertAt: number;
    if (sectionIdxs.length === 0) {
      insertAt = this.doc.tasks.length;
    } else if (task.done) {
      insertAt = sectionIdxs[sectionIdxs.length - 1] + 1;
    } else {
      const firstDone = sectionIdxs.find((i) => this.doc.tasks[i].done);
      insertAt = firstDone !== undefined ? firstDone : sectionIdxs[sectionIdxs.length - 1] + 1;
    }

    this.doc.tasks.splice(insertAt, 0, task);
  }

  public deleteTask(id: string): boolean {
    const idx = this.doc.tasks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.doc.tasks.splice(idx, 1);
    this.save();
    return true;
  }
}
