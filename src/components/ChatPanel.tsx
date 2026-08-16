"use client";

// React and hooks
import { useRef, useState, useEffect, useLayoutEffect, KeyboardEvent, FormEvent, memo } from "react";

// Markdown and syntax highlighting
import { marked } from "marked";
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import xml from 'highlight.js/lib/languages/xml'; // html is registered as xml in highlight.js
import 'highlight.js/styles/atom-one-dark.css';
// import TextType from "@/components/Text/TextType";

// Register highlight.js languages
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('html', xml);

// Local UI components
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { cachedUserId, supabase } from "@/lib/supabaseBrowser";
import { LEVELS, getModuleMeta } from "@/lib/modules";
import { getCurriculum, curriculumRoadmap, curriculumLessonCount } from "@/lib/curricula";
import { getRuntime } from "@/lib/runtimes/registry";
import { gradeSubmission } from "@/lib/agents/grade";
import ReadAloudButton from "@/components/ReadAloudButton";
import type { Roadmap, RoadmapNode } from "@/lib/agents/snowflake";
import type { Objective } from "@/lib/agents/lesson";
import { Check, Circle, RotateCcw, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { readChat, writeChat, type CachedChatMsg } from "@/lib/chatCache";
import { canResolveDocTerm } from "@/lib/docs-index";

marked.setOptions({ breaks: false });

// Post-process marked's HTML for a bot message:
//  1) Inline documentation links — authored as [text](doc:Term), rendered to
//     <a href="doc:Term">… — become inert, styled doc-links. The href is dropped (so a
//     stray click never navigates the page) and the term is carried on data-doc-term; the
//     chat bubble's click handler resolves it and opens the Docs tab.
//  2) Real external links (http/https) get target="_blank" so they open in a NEW browser
//     tab instead of navigating the whole app away.
function linkifyDocAnchors(html: string): string {
  return html
    .replace(
      /<a\s+href="doc:([^"]*)"([^>]*)>/gi,
      (_m, term: string, rest: string) =>
        `<a data-doc-term="${term}" class="doc-link" role="link" tabindex="0"${rest}>`
    )
    .replace(
      /<a\s+href="(https?:[^"]*)"((?:(?!target=)[^>])*)>/gi,
      (_m, href: string, rest: string) =>
        `<a href="${href}"${rest} target="_blank" rel="noopener noreferrer">`
    );
}

type Message = {
  id: number;
  text: string;
  role: 'user' | 'bot';
  // Orientation message (lesson intro / resume recap) tied to a lesson. These are PERSISTED
  // but deduped per lesson: opening a lesson replaces its previous orientation message(s)
  // rather than stacking new ones — so they survive refresh yet never pile up.
  lessonId?: string;
};

// Legacy cleanup on load: very old transcripts may hold UNTAGGED "Resuming **X** — N/M
// objectives done so far." recap lines (plus the bot explanation after each). Drop those
// pairs. Current orientation messages carry a lessonId and are deduped instead of purged.
const RESUMING_LINE = /^Resuming \*\*.+\*\* — \d+\/\d+ objectives done so far\.?$/;
// Recognises the calibration opener in a stored thread, so re-asking it can tell
// whether it is already the last thing said.
const LEVEL_QUESTION = /how would you describe your level/i;

function stripResumeRecaps<T extends { role: string; text: string; lessonId?: string }>(msgs: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (!msgs[i].lessonId && msgs[i].role === "bot" && RESUMING_LINE.test(msgs[i].text.trim())) {
      if (msgs[i + 1]?.role === "bot" && !msgs[i + 1].lessonId) i++; // drop the recap after it
      continue;
    }
    out.push(msgs[i]);
  }
  return out;
}


type ChatPanelProps = {
  moduleId?: string | null;
  /** The stored course this conversation belongs to. Chat is keyed by course, not
   *  module, so duplicated courses keep separate threads. */
  courseId?: string | null;
  /** Creates the course row on demand (first calibration answer) and returns its id. */
  ensureCourseId?: () => Promise<string | null>;
  /** Set by ensureCourseId when the free tier's course cap blocked creation — shown
   *  once as a bot message so hitting the limit is never silent. */
  courseLimitMessage?: string | null;
  /** What the course is about. Equals the module's title for an ordinary course; for a
   *  career path it is the PATH ("Backend Developer"), which is the subject every
   *  lesson on it should be framed by — not whichever language the path opened in. */
  skill?: string;
  /** Set only while STARTING a career path: its curriculum is fixed, so the cold-start
   *  asks for the learner's level and stops — there is no goal to ask for and no
   *  overview to generate. */
  pathTitle?: string | null;
  pathGoal?: string | null;
  onPathLevel?: (level: string) => void;
  visible?: boolean; // is the chat tab currently shown? (re-align when it becomes visible)
  onRoadmap?: (roadmap: Roadmap) => void;
  onRoadmapFailed?: (level: string, goal: string) => void; // save a stub course so it's listed/deletable
  lessonRequest?: { node: RoadmapNode; outline?: string; nonce: number } | null;
  nextLessonTitle?: string | null;
  submitRequest?: { code: string; output: string; nonce: number } | null;
  codeChange?: { code: string; nonce: number } | null;
  onLoadCode?: (code: string, html?: string) => void;
  onLessonComplete?: (pointId: string) => void;
  onOpenDoc?: (term: string) => void;
  boot?: "loading" | "fresh" | "resumed";
  hasRoadmap?: boolean;
  savedLevel?: string;
  savedGoal?: string;
  initialProgress?: Record<string, { built?: BuiltLesson; passed: string[]; code?: string; module?: string }> | null;
  onProgressChange?: (cache: Record<string, { built: BuiltLesson; passed: string[]; code?: string; module?: string }>) => void;
};

// Cold-start calibration: Level -> Goal -> generate first lesson.
type CalibStep = "level" | "goal" | "done";
type Calib = { step: CalibStep; level?: string; goal?: string };

// Active lesson with its fixed objectives + which are satisfied (the progress meter).
// `module` is the runtime THIS lesson runs in — the node's own when a path names
// one, the course's otherwise. Grading, guidance and the build all read it from
// here, so a submission is never judged against the wrong language.
type ActiveLesson = { pointId: string; title: string; objectives: Objective[]; passed: string[]; module: string | null };
type BuiltLesson = { intro: string; starterCode: string; html: string; objectives: Objective[]; solution?: string };


export default function ChatPanel({
  moduleId,
  courseId,
  ensureCourseId,
  courseLimitMessage,
  skill,
  pathTitle,
  pathGoal,
  onPathLevel,
  visible = true,
  onRoadmap,
  onRoadmapFailed,
  lessonRequest,
  nextLessonTitle,
  submitRequest,
  codeChange,
  onLoadCode,
  onLessonComplete,
  onOpenDoc,
  boot = "fresh",
  hasRoadmap = false,
  savedLevel,
  savedGoal,
  initialProgress,
  onProgressChange,
}: ChatPanelProps) {
  const meta = getModuleMeta(moduleId);
  // What this course is called in the conversation and, more importantly, what the
  // lesson and agent prompts are told the subject is. A path course opened in Python
  // is not a Python course, and a Go lesson inside it must not be framed as one.
  const subject = skill || meta?.title || "";
  // Starts EMPTY, and is filled a moment later by the cache (useLayoutEffect below)
  // or by the boot effect. It used to start with a hardcoded "What job you're
  // looking to land…", which every path then replaced — so the pane opened on a
  // question nobody had been asked, and on a resumed course that question sat there
  // for the length of two network requests before the real conversation arrived.
  // An empty pane for one frame is honest; the wrong question is not.
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [calib, setCalib] = useState<Calib>({ step: "done" });
  const [lesson, setLesson] = useState<ActiveLesson | null>(null);

  // Is the cold-start genuinely still running? Not the same as "calibration is
  // unfinished": calibration can be abandoned — the learner ignores the question and
  // starts a lesson from the roadmap — and it then sits pending forever, ready to
  // swallow a message meant for the tutor. It owns the input only while there is no
  // curriculum yet, or while a PATH is asking its single level question (a path seeds
  // its whole tree up front, so it has a roadmap from the very first frame).
  // An OPEN LESSON always wins: someone working through objectives who types
  // "how do I find the full name?" is asking about the lesson, never volunteering
  // their experience level. That is the exact message the reported bug swallowed.
  const calibrating =
    calib.step !== "done" &&
    !lesson &&
    (!hasRoadmap || (!!pathTitle && calib.step === "level"));
  const lessonRef = useRef<ActiveLesson | null>(null);
  useEffect(() => {
    lessonRef.current = lesson;
  }, [lesson]);
  // The lesson whose intro/recap was the assistant's MOST RECENT turn. Set when we post an
  // intro or resume recap; cleared the moment the learner does anything else (types, or
  // submits). Resuming a lesson that's still "freshly introduced" then skips repeating the
  // same rundown.
  const introducedRef = useRef<string | null>(null);
  // Per-node lesson cache: keeps each point's built lesson + objective progress so
  // switching between points retains progress (and skips re-generation). In-memory for
  // now; Supabase persistence layers on top once the project is reachable.
  const lessonCache = useRef<Record<string, { built: BuiltLesson; passed: string[]; code?: string; module?: string }>>({});

  // Seed the cache from saved (Supabase) progress so resumed lessons restore — including
  // the learner's edited code, not just the objectives.
  useEffect(() => {
    if (!initialProgress) return;
    const seeded: Record<string, { built: BuiltLesson; passed: string[]; code?: string; module?: string }> = {};
    for (const [id, v] of Object.entries(initialProgress)) {
      if (v.built) seeded[id] = { built: v.built, passed: v.passed ?? [], code: v.code, module: v.module };
    }
    lessonCache.current = { ...lessonCache.current, ...seeded };
  }, [initialProgress]);
  const GEMINI_MAX_CHARS = 8192;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Chat pagination: render only the most recent BATCH messages; scrolling to the top
  // reveals older ones a batch at a time (instead of mounting the whole conversation).
  const BATCH = 25;
  const [visibleCount, setVisibleCount] = useState(BATCH);
  const messagesRef = useRef(messages);
  const visibleCountRef = useRef(BATCH);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { visibleCountRef.current = visibleCount; }, [visibleCount]);

  const scrollRootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const followingRef = useRef(true);       // is the user viewing the newest message?
  const loadingMoreRef = useRef(false);    // an older-batch reveal is in flight
  const prevScrollHeightRef = useRef(0);   // to preserve position when prepending
  const pendingBottomRef = useRef(true);   // force align-to-latest (init / user action)
  const TOP_PAD = 8;                       // breathing room above the aligned message

  function getViewport(): HTMLElement | null {
    if (!viewportRef.current) {
      viewportRef.current =
        (scrollRootRef.current?.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null) ?? null;
    }
    return viewportRef.current;
  }

  // The DOM node of the newest rendered message (message bubbles carry data-chat-msg).
  function lastMsgEl(): HTMLElement | null {
    const vp = getViewport();
    if (!vp) return null;
    const nodes = vp.querySelectorAll("[data-chat-msg]");
    return (nodes[nodes.length - 1] as HTMLElement) ?? null;
  }

  // Scroll so the TOP of the newest message sits at the top of the chat area — the natural
  // place to start reading it. A short last message clamps to the bottom automatically.
  function alignLatestToTop() {
    const vp = getViewport();
    const el = lastMsgEl();
    if (vp && el) {
      vp.scrollTop += el.getBoundingClientRect().top - vp.getBoundingClientRect().top - TOP_PAD;
    } else if (vp) {
      vp.scrollTop = vp.scrollHeight;
    } else {
      messagesEndRef.current?.scrollIntoView();
    }
  }

  // Reset the window to the latest batch and re-align — used whenever the whole conversation
  // is (re)loaded, so we land on the newest message's start, not the top of the history.
  function resetToLatest() {
    pendingBottomRef.current = true;
    followingRef.current = true;
    setVisibleCount(BATCH);
  }

  // Attach a scroll listener to the Radix viewport: track whether the user is still on the
  // newest message and, near the top, reveal an older batch (preserving position on prepend).
  useEffect(() => {
    const vp = getViewport();
    if (!vp) return;
    const onScroll = () => {
      const el = lastMsgEl();
      // "Following" = the newest message's top is at/above the viewport top (we're reading it
      // from its start or below) — i.e. the user hasn't scrolled up into older history.
      followingRef.current = el
        ? el.getBoundingClientRect().top <= vp.getBoundingClientRect().top + 40
        : vp.scrollHeight - vp.scrollTop - vp.clientHeight < 80;
      if (vp.scrollTop < 60 && !loadingMoreRef.current && visibleCountRef.current < messagesRef.current.length) {
        loadingMoreRef.current = true;
        prevScrollHeightRef.current = vp.scrollHeight;
        setVisibleCount((c) => Math.min(c + BATCH, messagesRef.current.length));
      }
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After each render: preserve position when older messages were prepended, otherwise align
  // the newest message's top to the top of the chat area (init / new message, if following).
  useLayoutEffect(() => {
    const vp = getViewport();
    if (loadingMoreRef.current) {
      if (vp) vp.scrollTop = vp.scrollTop + (vp.scrollHeight - prevScrollHeightRef.current);
      loadingMoreRef.current = false;
      return;
    }
    if (pendingBottomRef.current || followingRef.current) {
      alignLatestToTop();
      pendingBottomRef.current = false;
    }
  }, [messages, visibleCount]);

  // The thinking bubble is rendered from `loading`, not from a message, so the alignment
  // effect above never sees it appear. When it shows while we're on the newest message,
  // scroll fully down so the bubble is in view below the message.
  useLayoutEffect(() => {
    if (!loading) return;
    const vp = getViewport();
    if (vp && (followingRef.current || pendingBottomRef.current)) {
      vp.scrollTop = vp.scrollHeight;
    }
  }, [loading]);

  // While the chat tab is hidden (display:none) it can't be scrolled or measured, so any
  // alignment is lost. When it becomes visible again, re-align to the newest message.
  const wasVisibleRef = useRef(visible);
  useLayoutEffect(() => {
    if (visible && !wasVisibleRef.current) {
      pendingBottomRef.current = true;
      alignLatestToTop();
      pendingBottomRef.current = false;
    }
    wasVisibleRef.current = visible;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    // Get user id from Supabase, and load chat history only when NOT doing a
    // module cold-start (calibration owns the conversation in that case).
    const getUserAndHistory = async () => {
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id ?? null;
      setUserId(uid);
      if (uid && !moduleId) {
        try {
          const res = await apiFetch("/api/functions/chat/history", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ limit: 50 })
          });
          const result = await res.json();
          if (Array.isArray(result.messages) && result.messages.length > 0) {
            setMessages(
              result.messages.map((msg: { content: string; role: string }, idx: number) => ({
                id: idx + 1,
                text: msg.content,
                role: msg.role === "assistant" ? "bot" : "user"
              }))
            );
            resetToLatest();
          }
        } catch {
          // Optionally handle error
        }
      }
    };
    getUserAndHistory();
  }, [moduleId]);

  // Same reason as in EditorPanels: the conversation is only persisted when there
  // is a userId, so signing in mid-run has to reach this component or the trial
  // chat stays unsaved until a reload.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setUserId(session?.user?.id ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Boot the conversation: restore the saved chat (logged-in) or start fresh.
  const chatBootKey = useRef<string | null>(null);
  const chatRestored = useRef(false);
  // Set once a trial conversation has been carried into a signed-in session.
  const adoptedTrial = useRef(false);
  // What the cache put on screen, if anything — so the network path below knows
  // whether it is replacing something the learner can already see.
  const cachePainted = useRef<Message[] | null>(null);

  // Paint the cached conversation BEFORE the browser paints anything.
  //
  // This deliberately does not wait for `boot`, for `userId`, or for the boot
  // effect below. Those all depend on network round trips — EditorPanels has to
  // load the course row before `boot` leaves "loading", and getUser() resolves a
  // promise before `userId` exists — and waiting on either is exactly the delay
  // this cache was built to remove. The user id comes from storage synchronously
  // (cachedUserId) for the same reason.
  //
  // useLayoutEffect, not useEffect: this runs after hydration but before paint, so
  // the conversation is on the first frame the learner actually sees, with no flash
  // of an empty pane. It cannot be a lazy useState initializer — the server renders
  // this component too, and a client-only value there is a hydration mismatch.
  useLayoutEffect(() => {
    if (cachePainted.current || !courseId) return;
    const hit = readChat(cachedUserId(), courseId);
    if (!hit?.messages?.length) return;
    const next = stripResumeRecaps(hit.messages).map((m, i) => ({
      id: i + 1,
      role: (m.role === "user" ? "user" : "bot") as "user" | "bot",
      text: m.text,
      lessonId: m.lessonId,
    }));
    cachePainted.current = next;
    setMessages(next);
    setCalib({
      step: (hit.calib?.step as CalibStep) ?? "done",
      level: hit.calib?.level ?? savedLevel,
      goal: hit.calib?.goal ?? savedGoal,
    });
    chatRestored.current = true;
    resetToLatest(); // open on the latest interactions, not the top of the history
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  useEffect(() => {
    if (!meta || boot === "loading") return;
    const key = `${courseId ?? moduleId}|${userId ?? "anon"}`;
    if (chatBootKey.current === key) return;

    // Signing in changes this key (anon → uid, then again once the course row
    // exists), but the conversation on screen is the very thing being saved.
    // Re-booting would drop a finished trial run back to the cold-start greeting.
    // Adopt it instead, and stop re-booting for the rest of the mount.
    if (adoptedTrial.current) {
      chatBootKey.current = key;
      return;
    }
    if (userId && chatBootKey.current?.endsWith("|anon")) {
      adoptedTrial.current = true;
      chatBootKey.current = key;
      return;
    }
    // The course row is created lazily, so courseId goes null -> id partway through a
    // conversation this component already booted. The key changes; the conversation
    // does not. Re-booting here would fetch a chat state that has not been saved yet
    // and fall through to the cold-start greeting, wiping the answer that caused the
    // row to be created in the first place. A path makes this the common case rather
    // than a race, since starting one creates the course immediately.
    if (courseId && chatBootKey.current === `${moduleId}|${userId ?? "anon"}`) {
      chatBootKey.current = key;
      return;
    }

    chatBootKey.current = key;

    // Open (or re-open) calibration at its first question. `returning` is for a
    // course that already exists because the learner left partway through this
    // very question — the course is not new to them, so it should not be greeted
    // as if it were, but the question is unchanged.
    const askLevel = (returning: boolean, existing?: Message[]) => {
      setCalib({ step: "level" });
      const opener = pathTitle
        ? returning
          ? `Picking up the **${pathTitle}** path — the whole curriculum is in the Roadmap tab.`
          : `You're starting the **${pathTitle}** path — the whole curriculum is already in the Roadmap tab.`
        : returning
          ? `Back to **${meta.title}**.`
          : `Let's learn **${meta.title}**.`;
      const text = `${opener} ${
        pathTitle ? "One question before we begin" : "To tailor it to you"
      } — how would you describe your level?`;
      // `existing` keeps a restored conversation and puts the question at the end
      // of it; without it the question IS the conversation (a cold start).
      const prior = existing ?? [];
      if (LEVEL_QUESTION.test(prior[prior.length - 1]?.text ?? "")) {
        return; // already the last thing said — asking twice reads as a stutter
      }
      setMessages([...prior, { id: prior.length + 1, role: "bot", text }]);
      resetToLatest();
    };

    // Adopt a stored conversation: newest batch in view, calibration restored.
    // Shared by the cache path and the network path so the two cannot land the
    // learner in different places.
    const adopt = (state: {
      messages?: unknown;
      calib?: { step?: string; level?: string; goal?: string };
    }) => {
      const raw = (state.messages ?? []) as { role: string; text: string; lessonId?: string }[];
      const next = stripResumeRecaps(raw).map((m, i: number) => ({
        id: i + 1,
        role: (m.role === "user" ? "user" : "bot") as "user" | "bot",
        text: m.text,
        lessonId: m.lessonId,
      }));
      setMessages(next);
      setCalib({
        step: (state.calib?.step as CalibStep) ?? "done",
        level: state.calib?.level ?? savedLevel,
        goal: state.calib?.goal ?? savedGoal,
      });
      chatRestored.current = true;
      resetToLatest(); // land on the newest batch, not the top of the history
      return next;
    };

    // The cache may already have put this conversation on screen (see the layout
    // effect above); if so, everything below is a revalidation, not a load.
    const painted = cachePainted.current;

    (async () => {
      // 1) Saved conversation? Restore it verbatim (messages + calibration).
      //    Only a course that already exists can have one.
      if (userId && courseId) {
        try {
          const res = await apiFetch(`/api/chat/state?course_id=${encodeURIComponent(courseId)}`);
          const { state } = await res.json();
          if (state?.messages?.length) {
            // The server is authoritative — but only over what the cache painted.
            // If the learner has already said something in the time this took,
            // replacing the thread would delete their message in front of them.
            const raw = state.messages as CachedChatMsg[];
            const unchanged =
              !painted ||
              (messagesRef.current.length === painted.length &&
                messagesRef.current[messagesRef.current.length - 1]?.text ===
                  painted[painted.length - 1]?.text);
            const same =
              painted &&
              painted.length === stripResumeRecaps(raw).length &&
              painted[painted.length - 1]?.text === raw[raw.length - 1]?.text;
            const shown = unchanged && !same ? adopt(state) : messagesRef.current;
            writeChat(userId, courseId, { messages: raw, calib: state.calib });
            chatRestored.current = true;
            // Same hole as below, one layer up: the conversation was saved but
            // calibration never finished, so nothing here knows the learner's
            // level and no lesson can be pitched at it. Put the question back at
            // the end of the thread rather than leaving it buried in history.
            if (!savedLevel && !state.calib?.level) askLevel(true, shown);
            return;
          }
        } catch {
          // Offline: the cached thread stays on screen rather than being replaced
          // by a cold-start greeting for a course that plainly has a history.
          if (painted) return;
        }
        if (painted) return;
      }
      // 2) Roadmap resumed but no saved chat.
      if (boot === "resumed") {
        // A course can be STORED before its calibration is finished. A path seeds
        // its whole curriculum the moment it is opened, so the row exists from the
        // first frame — close the tab on the level question and the course is
        // already in "My courses", with a tree and no idea who it is for.
        //
        // Welcoming that back as "your progress is restored" strands it: the
        // question is gone, nothing asks it again, and the level every lesson is
        // supposed to be pitched at is never learned. Ask it again instead. It is
        // the same question the cold start asks, because it is the same question.
        if (!savedLevel) {
          askLevel(true);
          return;
        }
        setCalib({ step: "done", level: savedLevel, goal: savedGoal });
        setMessages([
          {
            id: 0,
            role: "bot",
            text: `Welcome back to **${subject}**. Your roadmap and progress are restored — ask me anything, or open the Roadmap tab to pick your next lesson.`,
          },
        ]);
        return;
      }
      // 3) Fresh start -> cold-start. Two taps for a technology (level, then goal);
      //    one for a path, whose curriculum and goal are already decided.
      askLevel(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleId, courseId, boot, userId]);

  // Persist the conversation (debounced) whenever it changes — logged-in only.
  const chatSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!userId || !moduleId || messages.length === 0) return;
    // Don't save the initial single greeting unless the user has engaged or we restored.
    if (!chatRestored.current && messages.length < 2) return;
    if (chatSaveTimer.current) clearTimeout(chatSaveTimer.current);
    chatSaveTimer.current = setTimeout(async () => {
      // The course row may not exist yet — this is the first thing the learner has
      // said, so create it now and key the conversation to it.
      const cid = courseId ?? (await ensureCourseId?.());
      if (!cid) return;
      // Persist everything, carrying the lesson tag so orientation messages stay deduped.
      const persisted = messages.map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.lessonId ? { lessonId: m.lessonId } : {}),
      }));
      apiFetch("/api/chat/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
                    course_id: cid,
          module: moduleId,
          messages: persisted,
          calib: { step: calib.step, level: calib.level, goal: calib.goal },
        }),
      }).catch(() => {});
      // Cache what we just saved, so leaving and coming back is instant — and so a
      // failed save still leaves the learner's own words on screen next time.
      writeChat(userId, cid, {
        messages: persisted,
        calib: { step: calib.step, level: calib.level, goal: calib.goal },
      });
    }, 800);
    return () => {
      if (chatSaveTimer.current) clearTimeout(chatSaveTimer.current);
    };
  }, [messages, calib, userId, moduleId, courseId, ensureCourseId]);

  // Surface a blocked course creation as a normal chat message. courseLimitMessage
  // only ever changes value when the server's actual wording changes, so this
  // fires once per distinct block rather than on every retry that hits the cap.
  useEffect(() => {
    if (courseLimitMessage) pushMessage("bot", courseLimitMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseLimitMessage]);

  // Run the agent pipeline (chat manager) and return its reply + optional roadmap.
  async function callAgent(
    message: string,
    ctx?: { level?: string; goal?: string }
  ): Promise<{ response: string; roadmap?: Roadmap }> {
    const history = messages
      .slice(-10)
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
    try {
      const res = await apiFetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          topic: subject || meta?.title,
          level: ctx?.level ?? calib.level,
          goal: ctx?.goal ?? calib.goal,
          moduleId: moduleId ?? undefined,
          hasRoadmap,
          activeLesson: lessonRef.current?.title,
          history,
                  }),
      });
      const data = await res.json();
      if (data.error) return { response: data.error + (data.details ? `\n${data.details}` : "") };
      return { response: data.response || "(No response)", roadmap: data.roadmap };
    } catch {
      return { response: "Error contacting the tutor. Please try again." };
    }
  }

  // Message keys. `Date.now() + random(0..999)` collided in practice — the random
  // part is wide enough to overlap the next millisecond's base, so two messages
  // pushed a moment apart could land on the same id and React would drop one.
  // A counter cannot collide within a mount, which is all the key has to survive.
  const nextMessageId = useRef(Date.now());
  const newId = () => ++nextMessageId.current;

  function pushMessage(role: 'user' | 'bot', text: string) {
    // A message the learner sent should always bring the view to the bottom, even if they
    // were scrolled up reading history.
    if (role === "user") pendingBottomRef.current = true;
    setMessages((msgs) => [...msgs, { id: newId(), text, role }]);
  }

  // Show a lesson orientation message (intro / resume recap). Persisted but deduped per
  // lesson: by default it REPLACES this lesson's previous orientation message(s) so opening
  // a lesson never stacks duplicates. `append` adds to the current set instead (e.g. the
  // recap explanation that follows the "Resuming…" line). Always scrolls into view.
  function pushLesson(lessonId: string, text: string, append = false) {
    pendingBottomRef.current = true;
    setMessages((msgs) => {
      const base = append ? msgs : msgs.filter((m) => m.lessonId !== lessonId);
      return [...base, { id: newId(), text, role: "bot" as const, lessonId }];
    });
  }

  // Validate every rendered doc-link against the real documentation index, and DEMOTE
  // the ones that resolve to nothing back to plain text.
  //
  // The generator is asked for the "canonical documentation name" of an API, and it is
  // usually right — but "usually" means some links point at terms the docs do not carry.
  // Those used to render identically to working ones: the learner clicked, the pane
  // opened, and nothing relevant appeared. A link that cannot be honoured should not
  // look like a link.
  //
  // Runs after paint, per bubble, and marks what it has checked so each term is
  // examined once. Index-only — the index is fetched once per module and cached in
  // localStorage, so this costs no network per link.
  const docLinkModule = lesson?.module ?? moduleId ?? null;
  useEffect(() => {
    let cancelled = false;
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>("[data-doc-term]:not([data-doc-checked])")
    );
    if (nodes.length === 0) return;
    (async () => {
      for (const el of nodes) {
        let term = el.getAttribute("data-doc-term") || "";
        try {
          if (term.includes("%")) term = decodeURIComponent(term);
        } catch {
          /* keep raw term */
        }
        const ok = await canResolveDocTerm(docLinkModule, term);
        if (cancelled) return;
        el.setAttribute("data-doc-checked", ok ? "ok" : "dead");
        if (!ok) {
          // Strip every affordance: the click delegation keys on data-doc-term, so
          // removing it is what actually makes the text inert.
          el.removeAttribute("data-doc-term");
          el.removeAttribute("role");
          el.removeAttribute("tabindex");
          el.classList.remove("doc-link");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, docLinkModule]);

  // Delegated click for inline doc-links inside a bot bubble: resolve the term to a doc
  // section and open the Docs tab (handled upstream). preventDefault so nothing navigates.
  function handleDocClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = (e.target as HTMLElement).closest?.("[data-doc-term]");
    if (!el) return;
    e.preventDefault();
    let term = el.getAttribute("data-doc-term") || "";
    try {
      if (term.includes("%")) term = decodeURIComponent(term);
    } catch {
      /* keep raw term */
    }
    if (term) onOpenDoc?.(term);
  }

  // Background solution validation: run the cached reference solution in its real
  // runtime off-screen; if it errors, regenerate it to fit the (unchanged) lesson via
  // /api/lesson/fix-solution and re-validate. Silent — never touches the UI. Capped.
  const validatedPoints = useRef<Set<string>>(new Set());
  async function validateSolutionInBackground(pointId: string) {
    if (validatedPoints.current.has(pointId)) return;
    const cached = lessonCache.current[pointId];
    const built = cached?.built;
    if (!built?.solution) return;
    validatedPoints.current.add(pointId);
    const spec = getRuntime(lessonCache.current[pointId]?.module ?? moduleId);
    let solution = built.solution;
    for (let attempt = 0; attempt < 2; attempt++) {
      let err: string | null = null;
      try {
        const { findRuntimeErrors } = await import("@/lib/runtimes/validate");
        const probe = await findRuntimeErrors(spec, solution, built.html);
        err = probe.error;
        // Not just "no crash" — the reference solution must also pass every objective's
        // deterministic check. If it doesn't, the check/solution are inconsistent; feed
        // that as the failure so regeneration fixes it.
        if (!err) {
          const g = gradeSubmission(built.objectives, solution, probe.output);
          if (g.gradable && !g.allPassed) {
            err = "The reference solution does not satisfy the objective checks: " +
              g.results.filter((r) => !r.passed).map((r) => r.detail).join("; ");
          }
        }
      } catch {
        return; // validator itself failed — leave the solution as-is
      }
      if (!err) break; // runs clean AND passes its checks
      try {
        const res = await apiFetch("/api/lesson/fix-solution", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            objectives: built.objectives,
            starterCode: built.starterCode,
            html: built.html,
            solution,
            error: err,
            language: spec.langName,
          }),
        });
        const data = await res.json();
        if (!data.solution) break;
        solution = data.solution as string;
      } catch {
        break;
      }
    }
    // Persist the (possibly corrected) solution back into the cache + progress.
    if (lessonCache.current[pointId]) {
      lessonCache.current[pointId].built.solution = solution;
      onProgressChange?.(lessonCache.current);
    }

    // Check-repair invariant: if the solution runs CLEAN but still fails a check, the
    // CHECK is wrong (an invented constant no correct answer can produce — an unpassable
    // objective). Reground the failing checks on the solution's actual output.
    try {
      const rec = lessonCache.current[pointId];
      if (rec) {
        const { findRuntimeErrors } = await import("@/lib/runtimes/validate");
        const probe = await findRuntimeErrors(spec, solution, rec.built.html);
        if (!probe.error) {
          const g = gradeSubmission(rec.built.objectives, solution, probe.output);
          if (g.gradable && !g.allPassed) {
            const res = await apiFetch("/api/lesson/fix-checks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                objectives: rec.built.objectives,
                failingIds: g.results.filter((r) => !r.passed).map((r) => r.id),
                solution,
                solutionOutput: probe.output,
                language: spec.langName,
              }),
            });
            const data = await res.json();
            if (Array.isArray(data.objectives)) {
              rec.built.objectives = data.objectives;
              onProgressChange?.(lessonCache.current);
              // Live lesson open on this point → grade future submissions with the
              // repaired checks, keeping already-passed objectives.
              if (lessonRef.current?.pointId === pointId) {
                setLesson((l) => (l ? { ...l, objectives: data.objectives } : l));
              }
            }
          }
        }
      }
    } catch {
      /* check repair is best-effort */
    }

    // Gap invariant: the STARTER must NOT already satisfy the objectives (else there's
    // nothing to do — the "solution already in the starter" defect). Run it off-screen; if
    // it passes every check, regenerate a starter that leaves the work undone, and swap it
    // in when the learner hasn't started yet. (Pure JS is already gap-checked server-side.)
    try {
      const rec = lessonCache.current[pointId];
      if (!rec) return;
      const b = rec.built;
      const { findRuntimeErrors } = await import("@/lib/runtimes/validate");
      const probe = await findRuntimeErrors(spec, b.starterCode, b.html);
      const g = gradeSubmission(b.objectives, b.starterCode, probe.output);
      if (!g.gradable || !g.allPassed) return; // a real gap exists → nothing to fix
      const res = await apiFetch("/api/lesson/fix-starter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          objectives: b.objectives,
          starterCode: b.starterCode,
          solution: b.solution,
          html: b.html,
          language: spec.langName,
        }),
      });
      const data = await res.json();
      if (!data.starterCode) return;
      rec.built.starterCode = data.starterCode as string;
      onProgressChange?.(lessonCache.current);
      // If this lesson is open and untouched, load the corrected starter so the learner sees
      // a real exercise instead of the pre-solved one.
      if (lessonRef.current?.pointId === pointId && !rec.code && rec.passed.length === 0) {
        onLoadCode?.(rec.built.starterCode, rec.built.html);
      }
    } catch {
      /* gap check is best-effort */
    }
  }

  // Re-take the current lesson: clear passed objectives and reload the starter code.
  // Uses the cached built lesson — no rebuild / LLM call.
  function restartLesson() {
    if (!lesson) return;
    const cached = lessonCache.current[lesson.pointId];
    setLesson({ ...lesson, passed: [] });
    if (cached) {
      cached.passed = [];
      cached.code = undefined; // re-take starts from the scaffold again
      onProgressChange?.(lessonCache.current);
      onLoadCode?.(cached.built.starterCode, cached.built.html);
    }
    pushLesson(lesson.pointId, `Restarting **${lesson.title}** — starter code reloaded. Here's the rundown again:`);
    // Re-explain the topic + task (the cached lesson intro) so the learner has the
    // technical context on a restart, just like on first start. No rebuild/LLM call.
    if (cached?.built.intro) pushLesson(lesson.pointId, cached.built.intro, true);
    introducedRef.current = lesson.pointId; // restart rundown is the latest interaction
  }

  async function generateFirstLesson(level: string, goal: string) {
    if (!meta) return;
    setLoading(true);
    try {
      // A module with an authored curriculum does not generate its tree at all — the
      // syllabus is data (lib/curricula.ts), so the whole thing is built locally and
      // instantly. Level and goal are still asked and still kept: they are what each
      // LESSON is pitched at, which is the half that stays generated.
      const curriculum = getCurriculum(moduleId);
      if (curriculum) {
        const built = curriculumRoadmap(curriculum, level, goal);
        onRoadmap?.(built);
        pushMessage(
          "bot",
          `Your **${meta.title}** curriculum is ready — ${curriculumLessonCount(curriculum)} lessons ` +
            `across ${curriculum.chapters.length} chapters, in the order the language has to be learned. ` +
            `Starting you on the first one now; the whole plan is in the Roadmap tab.`
        );
        return;
      }
      // L1: grounded overview (snowflake). The tree is generated on demand from here.
      const res = await apiFetch("/api/roadmap/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // user_id + moduleId let the generator see the learner's OTHER courses for
        // this technology and avoid rebuilding ground they already have.
        body: JSON.stringify({
          skill: meta.title,
          level,
          goal,
          moduleId: moduleId ?? undefined,
                    course_id: courseId ?? undefined,
        }),
      });
      const data = await res.json();
      if (data.roadmap) {
        onRoadmap?.(data.roadmap);
        // The workspace is already building the first lesson (EditorPanels), so
        // this says what is happening rather than giving directions to do it by
        // hand. The Roadmap tab still gets a mention — it is how you go somewhere
        // OTHER than next.
        pushMessage(
          "bot",
          `Your **${meta.title}** roadmap is ready — starting you on the first lesson now. ` +
            `The whole plan is in the Roadmap tab whenever you want to jump elsewhere.`
        );
      } else if (data.code === "course_limit") {
        // Blocked before generation ever ran — there is no course shell to store
        // (that would just hit the same cap) and nothing was saved, so the
        // ordinary retry copy below (which promises exactly that) doesn't apply.
        pushMessage("bot", data.error);
      } else {
        onRoadmapFailed?.(level, goal); // store the course shell — listed, resumable, deletable
        pushMessage(
          "bot",
          (data.error || "I couldn't build the roadmap just now.") +
            // Nothing is stored for a trial visitor, so promising a saved course
            // would be a lie they'd discover on the next page load.
            (userId
              ? " Your course is saved — send any message here and I'll retry generating it."
              : " Send any message here and I'll retry.")
        );
      }
    } catch {
      onRoadmapFailed?.(level, goal);
      pushMessage(
        "bot",
        "I couldn't reach the roadmap service." +
          (userId
            ? " Your course is saved — send any message here and I'll retry."
            : " Send any message here and I'll retry.")
      );
    } finally {
      setLoading(false);
    }
  }

  // Record an answer for the current calibration step (from a chip tap OR typed text).
  async function answerCalibration(value: string) {
    const v = value.trim();
    if (!v || loading) return;
    pushMessage('user', v);
    if (calib.step === "level" && pathTitle) {
      // A path's curriculum is fixed and its goal is the job it is named after, so
      // there is nothing left to ask and nothing to generate — the tree is already
      // on screen. The level is still worth having: it is what every lesson on the
      // path is pitched at.
      setCalib({ step: "done", level: v, goal: pathGoal ?? undefined });
      onPathLevel?.(v);
      pushMessage(
        "bot",
        `Got it — *${v}*. Starting you on the first lesson of the **${pathTitle}** path now. ` +
          `The whole curriculum is in the Roadmap tab: work down it, or jump wherever you like.`
      );
    } else if (calib.step === "level") {
      setCalib((c) => ({ ...c, step: "goal", level: v }));
      pushMessage('bot', `Got it — *${v}*. And what's your goal with ${meta?.title ?? "it"}?`);
    } else if (calib.step === "goal") {
      const level = calib.level ?? "Some experience";
      setCalib((c) => ({ ...c, step: "done", goal: v }));
      // NEVER generate over a curriculum that already exists. Calibration can be
      // left unfinished — the learner ignores the question and starts a lesson from
      // the roadmap, which is a perfectly sensible thing to do — and it is then
      // still "pending" days later. Reaching this branch with a roadmap already on
      // screen used to REPLACE it, which on a career path threw away the entire
      // fixed curriculum and handed back a generated single-technology one.
      if (hasRoadmap) {
        pushMessage("bot", `Noted — *${v}*. I'll pitch your lessons at that. Your roadmap is unchanged.`);
        return;
      }
      await generateFirstLesson(level, v);
    }
  }

  async function handleSend(e?: FormEvent | KeyboardEvent) {
    e?.preventDefault();
    if (input.trim() === "" || loading) return;
    const text = input;
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    // During cold-start, a typed message answers the current calibration step —
    // but ONLY while cold-start is genuinely what is happening. Once a roadmap
    // exists the learner is working, not being onboarded, and "how do I find the
    // full name?" is a question about the open lesson, not their experience level.
    // Answering it as calibration is how a lesson question ended up two messages
    // later regenerating the curriculum.
    if (calibrating) {
      answerCalibration(text);
      return;
    }
    // Calibration was abandoned mid-way and the learner moved on. Close it out
    // silently rather than leaving it pending forever, waiting to swallow a message.
    if (calib.step !== "done") {
      setCalib((c) => ({ ...c, step: "done" }));
    }

    // Calibrated but no roadmap (an earlier generation failed) → any message retries
    // generation; without a roadmap there is nothing else to converse about.
    if (!hasRoadmap && meta) {
      pushMessage('user', text);
      pushMessage('bot', `Retrying your **${meta.title}** roadmap…`);
      await generateFirstLesson(calib.level ?? "Some experience", calib.goal ?? "general mastery");
      return;
    }

    pushMessage('user', text);
    introducedRef.current = null; // the learner moved the conversation on
    setLoading(true);
    try {
      const { response, roadmap } = await callAgent(text);
      if (roadmap) onRoadmap?.(roadmap); // send to the side-tab (no text dump)
      pushMessage('bot', response);
    } finally {
      setLoading(false);
    }
  }

  // When a roadmap node's "Start lesson" is clicked, generate that node's lesson.
  const handledLessonNonce = useRef(0);
  useEffect(() => {
    if (!lessonRequest || lessonRequest.nonce === handledLessonNonce.current) return;
    // Not consumed until it is actually handled. Marking it handled and then
    // bailing on `loading` below silently threw the click away: pick a lesson
    // while another is still building and the workspace simply did nothing, with
    // no way to retry but clicking again. `loading` is in this effect's deps, so
    // a request that arrives mid-build runs the moment the build finishes.
    if (loading) return;
    handledLessonNonce.current = lessonRequest.nonce;
    const node = lessonRequest.node;
    // A path's nodes carry their own runtime; a single-technology course's do not
    // and fall back to the course module. Everything this lesson does — build,
    // grade, guide — uses this and not the module the learner clicked on the
    // landing page.
    const lessonModule = node.module ?? moduleId ?? null;
    // Starting/resuming a lesson is an explicit action → always bring its intro/recap into
    // view (align it to the top), even if the user wasn't following the newest message.
    pendingBottomRef.current = true;
    (async () => {
      // Resume a previously-opened lesson: restore its objectives + progress, no rebuild.
      const cached = lessonCache.current[node.id];
      if (cached) {
        // If this lesson's intro/recap was the assistant's last turn, re-selecting it must
        // NOT repeat the same rundown. Restore state silently (without clobbering in-progress
        // code if it's already the active lesson) and stop.
        if (introducedRef.current === node.id) {
          if (lessonRef.current?.pointId !== node.id) {
            setLesson({ pointId: node.id, title: node.title, objectives: cached.built.objectives, passed: cached.passed, module: lessonModule });
            onLoadCode?.(cached.code ?? cached.built.starterCode, cached.built.html);
          }
          void validateSolutionInBackground(node.id);
          return;
        }
        setLesson({ pointId: node.id, title: node.title, objectives: cached.built.objectives, passed: cached.passed, module: lessonModule });
        // Restore the learner's edited code if we have it, else the starter scaffold.
        const hasCode = !!cached.code;
        onLoadCode?.(cached.code ?? cached.built.starterCode, cached.built.html);
        introducedRef.current = node.id; // this lesson's rundown is now the latest interaction
        // Verify the reference solution once per session (covers lessons restored from
        // the DB that were never validated in a browser).
        void validateSolutionInBackground(node.id);

        // Opened before but NO objectives done yet → nothing to "resume". Re-present the
        // lesson intro (deduped by lessonId, so it replaces the old copy instead of stacking)
        // so opening the lesson always shows and scrolls to its content.
        if (cached.passed.length === 0) {
          pushLesson(node.id, cached.built.intro || `Let's work on ${node.title}.`);
          return;
        }

        // Deduped per lesson: replaces any prior recap for this lesson (no pile-up).
        pushLesson(
          node.id,
          `Resuming **${node.title}** — ${cached.passed.length}/${cached.built.objectives.length} objectives done so far.`
        );
        // Re-explain the lesson IN THE CONTEXT of their progress: recap the topic and
        // point them at the next unmet objective (LLM call, informed by passed/remaining).
        (async () => {
          try {
            setLoading(true);
            const passedSet = new Set(cached.passed);
            const res = await apiFetch("/api/lesson/explain", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                pointTitle: node.title,
                language: getRuntime(lessonModule).langName,
                moduleId: lessonModule ?? undefined,
                intro: cached.built.intro,
                hasCode,
                objectives: cached.built.objectives.map((o) => ({
                  description: o.description,
                  passed: passedSet.has(o.id),
                })),
              }),
            });
            const data = await res.json();
            if (data.message) pushLesson(node.id, data.message, true); // append to this lesson's recap
          } catch {
            /* recap is best-effort — the quick "Resuming…" line already landed */
          } finally {
            setLoading(false);
          }
        })();
        return;
      }
      setLoading(true);
      try {
        // L4: grounded lesson — intro + starter code + FIXED objectives.
        const res = await apiFetch("/api/lesson/build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            skill: subject || node.title,
            level: calib.level,
            goal: calib.goal,
            moduleId: lessonModule ?? undefined,
            pointTitle: node.title,
            pointSummary: node.summary || node.description,
            treeOutline: lessonRequest.outline,
            // Lets the lesson skip what this learner finished in OTHER courses.
            course_id: courseId ?? undefined,
          }),
        });
        const data = await res.json();
        if (data.lesson) {
          const l = data.lesson as { intro: string; starterCode: string; html?: string; objectives: Objective[]; solution?: string };
          lessonCache.current[node.id] = {
            built: { intro: l.intro, starterCode: l.starterCode, html: l.html || "", objectives: l.objectives, solution: l.solution },
            passed: [],
            module: lessonModule ?? undefined,
          };
          onProgressChange?.(lessonCache.current);
          setLesson({ pointId: node.id, title: node.title, objectives: l.objectives, passed: [], module: lessonModule });
          onLoadCode?.(l.starterCode, l.html);
          // Intro is real lesson content → persisted, and tagged so re-opening replaces it
          // rather than stacking a duplicate.
          pushLesson(node.id, l.intro || `Let's work on ${node.title}.`);
          introducedRef.current = node.id; // fresh intro is the latest interaction
          // Background: verify the reference solution runs in the real runtime; if it
          // errors, regenerate it to fit the lesson (no UI disruption).
          void validateSolutionInBackground(node.id);
        } else {
          pushMessage("bot", data.error || "I couldn't build that lesson — try again.");
        }
      } catch {
        pushMessage("bot", "I couldn't reach the lesson service. Please try again.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonRequest, loading]);

  // Persist the learner's edited code into the active lesson's cache (debounced upstream
  // in CodeHere) so resuming restores their work, not just the objectives.
  const handledCodeNonce = useRef(0);
  useEffect(() => {
    if (!codeChange || codeChange.nonce === handledCodeNonce.current) return;
    handledCodeNonce.current = codeChange.nonce;
    const active = lessonRef.current;
    if (!active) return;
    const rec = lessonCache.current[active.pointId];
    if (!rec) return;
    rec.code = codeChange.code;
    onProgressChange?.(lessonCache.current); // flows to progress → Supabase (debounced there)
  }, [codeChange]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the learner hits "Submit" in the editor, send the code + console output
  // to the tutor for review.
  const handledSubmitNonce = useRef(0);
  useEffect(() => {
    if (!submitRequest || submitRequest.nonce === handledSubmitNonce.current) return;
    handledSubmitNonce.current = submitRequest.nonce;
    const { code, output } = submitRequest;
    introducedRef.current = null; // a submission is a new interaction; later resume may recap
    pendingBottomRef.current = true; // submitting is a user action → align to the response
    (async () => {
      if (loading) return;
      setLoading(true);
      try {
        const active = lessonRef.current;
        if (active) {
          // 1) DETERMINISTIC grading (authoritative). The LLM never decides pass/fail.
          const grade = gradeSubmission(active.objectives, code, output);
          let passed: string[];
          if (grade.gradable) {
            passed = Array.from(new Set([...active.passed, ...grade.results.filter((r) => r.passed).map((r) => r.id)]));
          } else {
            // Legacy lesson with no machine checks → fall back to the LLM grader.
            const res = await apiFetch("/api/lesson/evaluate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                pointTitle: active.title,
                objectives: active.objectives,
                code,
                output,
                alreadyPassed: active.passed,
                language: getRuntime(active.module).langName,
              }),
            });
            const data = await res.json();
            const results: { id: string; passed: boolean }[] = Array.isArray(data.results) ? data.results : [];
            passed = Array.from(new Set([...active.passed, ...results.filter((r) => r.passed).map((r) => r.id)]));
            if (data.message) pushMessage("bot", data.message);
          }

          setLesson({ ...active, passed });
          if (lessonCache.current[active.pointId]) {
            lessonCache.current[active.pointId].passed = passed; // retain progress
            lessonCache.current[active.pointId].code = code;     // checkpoint the submitted code
          }
          onProgressChange?.(lessonCache.current);

          const allDone = active.objectives.every((o) => passed.includes(o.id));
          if (allDone) {
            // All objectives met → hard-coded completion + auto-advance. No LLM call.
            pushMessage("bot", `**Lesson complete** — all objectives met for "${active.title}".`);
            if (nextLessonTitle) {
              pushMessage("bot", `Nice work — moving you to the next lesson: **${nextLessonTitle}** →`);
            } else {
              pushMessage("bot", `That wraps up the loaded roadmap — great job! Open the next point from the roadmap whenever you're ready.`);
            }
            onLessonComplete?.(active.pointId);
          } else if (grade.gradable) {
            // 2) GUIDANCE (the LLM's real job): only when something failed, fed the
            // deterministic results so it teaches the actual gap instead of re-judging.
            try {
              const gres = await apiFetch("/api/lesson/guide", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  pointTitle: active.title,
                  language: getRuntime(active.module).langName,
                  moduleId: active.module ?? undefined,
                  code,
                  output,
                  results: active.objectives.map((o) => {
                    const r = grade.results.find((x) => x.id === o.id);
                    return { id: o.id, description: o.description, passed: !!r?.passed, detail: r?.detail };
                  }),
                }),
              });
              const gdata = await gres.json();
              if (gdata.message) pushMessage("bot", gdata.message);
            } catch {
              /* guidance is best-effort */
            }
          }
        } else {
          // No active lesson: silent generic continuation.
          const modelMsg =
            `[silent submission context — do not thank or announce]\n` +
            `THEIR CODE:\n${code}\n\nCONSOLE OUTPUT:\n${output.trim() || "(no output)"}\n\n` +
            `Assess and continue teaching concisely.`;
          const { response } = await callAgent(modelMsg);
          pushMessage("bot", response);
        }
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitRequest]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      handleSend(e);
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  }

  // Memoized message bubble for performance
  const MessageBubble = memo(function MessageBubble({ msg }: { msg: Message }) {
    if (msg.role === 'user') {
      return (
        <div className={`flex my-4 justify-end`} data-chat-msg>
          <div className="bg-scrim px-4 py-2 text-sm border border-line-strong max-w-[100%] sm:max-w-[60%] font-normal leading-normal text-ink text-right">
            {msg.text}
          </div>
        </div>
      );
    }
    // Memoize marked and highlight.js output for bot messages
    const parts = msg.text.split(/(```[\s\S]*?```)/g);
    const rendered = parts.map((part, i) => {
      if (part.startsWith('```') && part.endsWith('```')) {
        // Extract language and code
        const codeBlock = part.slice(3, -3);
        const firstLineBreak = codeBlock.indexOf('\n');
        let lang = '';
        let code = codeBlock;
        if (firstLineBreak !== -1) {
          lang = codeBlock.slice(0, firstLineBreak).trim();
          code = codeBlock.slice(firstLineBreak + 1);
        }
        let highlighted;
        if (lang && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(code, { language: lang }).value;
        } else {
          highlighted = hljs.highlightAuto(code).value;
        }
        return (
          <pre
            key={i}
            className="theme-atom-one-dark shadow-3xl text-sm relative max-w-full order-1 lg:order-2 my-50"
            style={{ padding: 0, margin: 0 }}
          >
            <span className="hljs my-5 p-4 block min-h-full">
              <code className="whitespace-pre-wrap break-words" dangerouslySetInnerHTML={{ __html: highlighted }} />
            </span>
            <small className="bg-surface-0/30 absolute top-0 right-0 uppercase font-bold text-xs px-2 py-1">
              <span className="sr-only">Language:</span>{lang ? lang.charAt(0).toUpperCase() + lang.slice(1) : 'Code'}
            </small>
          </pre>
        );
      } else {
        // Use marked to render all Gemini Markdown as intended, then turn the assistant's
        // inline [text](doc:Term) references into clickable doc-links (handled by the
        // bubble's click delegation — the href is stripped so nothing navigates away).
        const html = linkifyDocAnchors(marked.parse(part.trim(), { async: false }) as string);
        return (
          <div className="flex flex-col gap-5" key={i} dangerouslySetInnerHTML={{ __html: html }} />
        );
      }
    });
    return (
      <div className={`flex my-4 justify-start`} data-chat-msg>
        <div
          className="group bg-scrim px-4 py-2 text-sm border border-line-strong max-w-[100%] sm:max-w-[90%] font-normal leading-relaxed text-ink-muted text-left"
          onClick={handleDocClick}
        >
          <span>{rendered}</span>
          <div className="mt-1.5 flex justify-end">
            <ReadAloudButton id={String(msg.id)} text={msg.text} />
          </div>
        </div>
      </div>
    );
  });

  return (
    <div className="flex flex-col h-full w-full min-w-0 border border-line-strong backdrop-blur-md font-sans overflow-x-auto">
          {/* EU AI Act Art. 50, applicable 2 August 2026: a person interacting with an
              AI system must be informed of that, at the point of first interaction and
              in a clear, accessible way.

              It is a permanent bar rather than a line in the opening message on purpose.
              The opening message scrolls away after two exchanges, and a restored
              conversation never shows it at all — so a disclosure that lives there is
              absent for exactly the returning user who has stopped thinking about it.
              This sits above every message, in every state of the panel, always.

              `role="note"` and the fixed wording keep it findable by a screen reader,
              which is part of what "accessible" is asking for. See
              docs/gdpr-and-compliance.md §8. */}
          <div
            role="note"
            className="flex items-center gap-1.5 border-b border-line-strong px-4 py-1.5 text-meta text-ink-dim"
          >
            <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span>
              You&rsquo;re talking to an AI tutor. Replies are generated and can be wrong —
              check anything that matters.
            </span>
          </div>
          {lesson && (
            <div className="border-b border-line-strong px-4 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-semibold text-ink">{lesson.title}</span>
                <span className="shrink-0 text-meta text-ink-dim">
                  {lesson.passed.length}/{lesson.objectives.length} objectives
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden bg-surface-2">
                <div
                  className="h-full bg-accent transition-all duration-300"
                  style={{ width: `${(lesson.passed.length / Math.max(1, lesson.objectives.length)) * 100}%` }}
                />
              </div>
              <ul className="mt-2 space-y-1">
                {lesson.objectives.map((o) => {
                  const done = lesson.passed.includes(o.id);
                  return (
                    <li key={o.id} className="flex items-start gap-1.5 text-meta leading-snug">
                      {done ? (
                        <Check className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
                      ) : (
                        <Circle className="mt-0.5 h-2.5 w-2.5 shrink-0 text-ink-faint" />
                      )}
                      <span className={done ? "text-ink-dim line-through" : "text-ink-muted"}>{o.description}</span>
                    </li>
                  );
                })}
              </ul>
              {lesson.objectives.length > 0 && lesson.objectives.every((o) => lesson.passed.includes(o.id)) && (
                <button
                  type="button"
                  onClick={restartLesson}
                  title="Reset progress and reload the starter code"
                  className="mt-2.5 inline-flex items-center gap-1.5 border border-line-strong bg-scrim px-2.5 py-1 text-meta 
                             text-ink-muted leading-none transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <RotateCcw className="h-3 w-3" />
                  Re-take lesson
                </button>
              )}
            </div>
          )}
          <div ref={scrollRootRef} className="flex-1 min-h-0 flex">
          <ScrollArea className="h-full w-full overflow-y-auto overflow-hidden px-6 space-y-2 font-normal leading-normal">
            {/* highlight.js theme handles code styling */}
            <div className="space-y-5">
              {visibleCount < messages.length && (
                <div className="pt-2 pb-1 text-center text-meta text-ink-faint">
                  Scroll up for earlier messages…
                </div>
              )}
              {messages.length === 0 ? (
                <div className="text-ink-dim text-center mt-8 font-normal leading-normal">No messages yet. Start the conversation below!
                </div>
              ) : (
                (visibleCount >= messages.length ? messages : messages.slice(-visibleCount)).map((msg) => (
                  <MessageBubble key={msg.id} msg={msg} />
                ))
              )}
              {calibrating && !loading && (
                <div className="flex justify-start">
                  <div className="flex max-w-[100%] flex-wrap gap-2 sm:max-w-[60%]">
                    {(calib.step === "level" ? [...LEVELS] : (meta?.goals ?? [])).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        disabled={loading}
                        onClick={() => answerCalibration(opt)}
                        className="border border-line-strong bg-scrim px-3 py-1.5 text-xs text-ink
                                   leading-none transition-colors hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {opt}
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => textareaRef.current?.focus()}
                      className="border border-dashed border-line-strong bg-transparent px-3 py-1.5 text-xs text-ink-muted
                                 leading-none transition-colors hover:border-line-active hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Type my own…
                    </button>
                  </div>
                </div>
              )}
              {loading && (
                // Same vertical rhythm as a real message bubble — without my-4 this
                // sat flush against the message above it and against the composer.
                <div className="flex my-4 justify-start">
                  <div className="bg-surface-1 px-4 py-2 text-sm border border-line-strong max-w-[100%] sm:max-w-[90%] font-normal leading-relaxed text-ink-muted text-left opacity-70 gemini-glow">
                    Thinking...
                  </div>
                </div>
              )}
            </div>
            {/* Breathing room under the last bubble so nothing touches the composer. */}
            <div ref={messagesEndRef} className="h-4" />
            <ScrollBar orientation="vertical" />
          </ScrollArea>
          </div>
          <form
            className="flex items-center gap-2 p-4 border-t border-line-strong"
            onSubmit={handleSend}
          >
            <Textarea
              ref={textareaRef}
              className="flex-1 min-h-[40px] max-h-40 resize-none px-4 py-2 bg-surface-0 text-ink placeholder:text-ink-dim placeholder:font-normal placeholder:leading-normal border border-line-strong focus:border-line-active focus:outline-none font-normal leading-normal overflow-y-auto overflow-x-auto"
              placeholder={calibrating ? "Tap an option or type your answer…" : "Type a message..."}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              rows={1}
              maxLength={GEMINI_MAX_CHARS}
            />
            <button
              type="submit"
              className="px-4 py-2 bg-surface-3 hover:bg-surface-3 text-surface-0 font-normal leading-normal border border-line-strong transition-colors duration-150 flex items-center justify-center"
              aria-label="Send"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </form>
    </div>
  );
}
