import { randomBytes } from 'crypto';
import { logger } from '../logger.js';

export interface ChallengeSession {
  sessionId: string;
  challenge: string;
  topic: string;
  asciiTarget: number;
  wordCount: number;
  timeLimit: number; // seconds
  createdAt: number;
  expiresAt: number;
  solved: boolean;
}

// In-memory store (in production, use Redis or database)
const sessions = new Map<string, ChallengeSession>();

// Clean up expired sessions every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt < now) {
      sessions.delete(id);
    }
  }
}, 2 * 60 * 1000);

const TOPICS = [
  'verification',
  'agents',
  'blockchain',
  'tokens',
  'deployment',
  'cryptography',
  'automation',
  'intelligence',
  'security',
  'trust',
  'innovation',
  'future',
];

/**
 * Generate a random haiku challenge.
 * Intentionally simple: just 3 lines that mention the topic.
 * No math puzzles — any LLM can solve this instantly.
 */
export function generateChallenge(): ChallengeSession {
  const sessionId = randomBytes(16).toString('hex');
  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];

  const challenge = `Write a haiku (3 lines) about "${topic}". Your response must contain exactly 3 lines and mention the word "${topic}".`;

  const now = Date.now();
  const session: ChallengeSession = {
    sessionId,
    challenge,
    topic,
    asciiTarget: 0,  // unused
    wordCount: 0,    // unused
    timeLimit: 300,  // 5 minutes
    createdAt: now,
    expiresAt: now + 5 * 60 * 1000, // 5 minute expiry
    solved: false,
  };
  
  sessions.set(sessionId, session);
  logger.info('Generated agent captcha challenge', { sessionId, topic });
  
  return session;
}

/**
 * Verify a haiku response against challenge constraints
 */
export function verifyChallenge(
  sessionId: string,
  response: string,
): {
  valid: boolean;
  error?: string;
  session?: ChallengeSession;
} {
  const session = sessions.get(sessionId);
  
  if (!session) {
    return { valid: false, error: 'Session not found' };
  }
  
  if (session.solved) {
    return { valid: false, error: 'Challenge already solved' };
  }
  
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return { valid: false, error: 'Challenge expired' };
  }
  
  const lines = response.trim().split('\n').filter(l => l.trim());

  if (lines.length !== 3) {
    return { valid: false, error: `Expected 3 lines (haiku), got ${lines.length}. Send newline-separated lines.` };
  }

  // Topic must appear somewhere in the haiku
  if (!response.toLowerCase().includes(session.topic.toLowerCase())) {
    return { valid: false, error: `Haiku must mention the topic "${session.topic}"` };
  }

  // Mark as solved — JWT handles expiry from here
  session.solved = true;
  
  logger.info('Agent captcha challenge verified', { sessionId });
  
  return { valid: true, session };
}

/**
 * Mark challenge as used (one deployment per challenge)
 */
export function markChallengeUsed(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session && session.solved) {
    sessions.delete(sessionId);
    return true;
  }
  return false;
}

/**
 * Get session (for debugging)
 */
export function getSession(sessionId: string): ChallengeSession | undefined {
  return sessions.get(sessionId);
}
