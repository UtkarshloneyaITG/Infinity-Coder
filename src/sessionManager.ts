import * as vscode from 'vscode';
import { ChatMessage } from './types';

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export class SessionManager {
  private static readonly STORAGE_KEY = 'infinity_coder_chat_sessions';
  private static readonly ACTIVE_SESSION_KEY = 'infinity_coder_active_session_id';

  constructor(private context: vscode.ExtensionContext) {}

  public getSessions(): ChatSession[] {
    return this.context.globalState.get<ChatSession[]>(SessionManager.STORAGE_KEY, []);
  }

  public getActiveSessionId(): string | undefined {
    return this.context.globalState.get<string>(SessionManager.ACTIVE_SESSION_KEY);
  }

  public setActiveSessionId(id: string): void {
    this.context.globalState.update(SessionManager.ACTIVE_SESSION_KEY, id);
  }

  public createSession(initialTitle: string = 'New Chat'): ChatSession {
    const newSession: ChatSession = {
      id: `session-${Date.now()}`,
      title: initialTitle,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };

    const sessions = this.getSessions();
    sessions.unshift(newSession); // newest first
    this.context.globalState.update(SessionManager.STORAGE_KEY, sessions);
    this.setActiveSessionId(newSession.id);
    return newSession;
  }

  public saveSession(session: ChatSession): void {
    const sessions = this.getSessions();
    const index = sessions.findIndex(s => s.id === session.id);
    session.updatedAt = Date.now();

    if (index >= 0) {
      sessions[index] = session;
    } else {
      sessions.unshift(session);
    }

    this.context.globalState.update(SessionManager.STORAGE_KEY, sessions);
  }

  public deleteSession(id: string): void {
    let sessions = this.getSessions();
    sessions = sessions.filter(s => s.id !== id);
    this.context.globalState.update(SessionManager.STORAGE_KEY, sessions);

    if (this.getActiveSessionId() === id) {
      const nextId = sessions.length > 0 ? sessions[0].id : undefined;
      if (nextId) {
        this.setActiveSessionId(nextId);
      } else {
        this.context.globalState.update(SessionManager.ACTIVE_SESSION_KEY, undefined);
      }
    }
  }

  public getSession(id: string): ChatSession | undefined {
    const sessions = this.getSessions();
    return sessions.find(s => s.id === id);
  }
}
