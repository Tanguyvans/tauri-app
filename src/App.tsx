import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Link, useNavigate, useLocation } from 'react-router-dom';
import Database from '@tauri-apps/plugin-sql'; // Import the JS bindings
import HomePage from './pages/HomePage';
import ChatPage from './pages/ChatPage';
import SettingsPage from './pages/Settings';
import './App.css'; // Keep global styles (now includes layout)

// Define Conversation type for frontend state
interface Conversation {
  id: number; // Use number for consistency
  name: string;
  created_at: string;
}

const DB_NAME = "sqlite:chat_history_persistent.db";

function App() {
  const [db, setDb] = useState<Database | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isDbLoading, setIsDbLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation(); // To highlight active chat

  // --- Initialize DB and Load Conversations ---
  const initializeDatabase = useCallback(async () => {
    setIsDbLoading(true);
    setDbError(null);
    try {
      console.log("Loading database:", DB_NAME);
      const loadedDb = await Database.load(DB_NAME);
      setDb(loadedDb);
      console.log("Database loaded successfully.");

      // Ensure tables exist (replaces backend migrations)
      console.log("Ensuring tables exist...");
      await loadedDb.execute(`
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );`);
      await loadedDb.execute(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );`);
      await loadedDb.execute(`
        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL,
            -- conversation_id is NOT created here initially
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );`);

      // --- ADDED: Attempt to add the conversation_id column ---
      // This might throw an error if the column already exists, but SQLite often handles this gracefully.
      // A more robust way would involve checking PRAGMA table_info first, but this is simpler.
      try {
          console.log("Attempting to add conversation_id column...");
          await loadedDb.execute(`
              ALTER TABLE chat_messages ADD COLUMN conversation_id INTEGER REFERENCES conversations(id);
          `);
          console.log("conversation_id column checked/added.");
      } catch (alterError: any) {
          // Ignore "duplicate column name" error, which is expected if run previously
          if (!alterError.message?.includes('duplicate column name')) {
              console.warn("Error during ALTER TABLE (may be ok if column exists):", alterError);
              // Rethrow if it's not the expected duplicate column error? Or just log it.
              // throw alterError; // Optionally re-throw unexpected errors
          } else {
              console.log("conversation_id column already exists.");
          }
      }
      // --- END ADDED ---

      // Create index AFTER potentially adding the column
       await loadedDb.execute(`
            CREATE INDEX IF NOT EXISTS idx_conversation_id ON chat_messages(conversation_id);
       `);
        // Ensure default context exists (safer than relying on backend migration)
        await loadedDb.execute(`
            INSERT OR IGNORE INTO settings (key, value) VALUES ($1, $2)
        `, ["global_system_prompt", "You are a helpful assistant."]); // Use parameters

      console.log("Tables checked/created.");

      // Load conversations list
      await loadConversations(loadedDb);

    } catch (e: any) {
      console.error("Database initialization error:", e);
      // Make the error message more specific if possible
      setDbError(`Failed to initialize database: ${e?.message || e}. Please check console or restart.`);
      setDb(null); // Ensure db is null on error
    } finally {
      setIsDbLoading(false);
    }
  }, []); // No dependencies, runs once

  useEffect(() => {
    initializeDatabase();
    // Optional: Close DB on unmount? Maybe not needed for Tauri apps.
    // return () => { db?.close(); }
  }, [initializeDatabase]); // Run once on mount

  // --- Function to load conversations ---
  const loadConversations = async (database: Database | null = db) => {
    if (!database) return;
    try {
      console.log("Loading conversations from DB...");
      // Use query parameters $1, $2 etc. even if none are needed for select *
      const loadedConvos: Conversation[] = await database.select(
        "SELECT id, name, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) as created_at FROM conversations ORDER BY created_at DESC"
      );
      setConversations(loadedConvos);
      console.log(`Loaded ${loadedConvos.length} conversations.`);
    } catch (error: any) {
      console.error("Error loading conversations:", error);
      setDbError(`Failed to load conversations: ${error?.message || error}`);
    }
  };

  // --- Handle Creating a New Chat ---
  const handleNewChat = async () => {
    if (!db) {
      setDbError("Database not connected. Cannot create chat.");
      return;
    }
    try {
      console.log("Creating new conversation...");
      // Using execute for INSERT and relying on reload + navigate logic below
      await db.execute(
        "INSERT INTO conversations (name) VALUES ($1)",
        ["New Chat"]
      );
      console.log("New conversation created statement executed.");

      // Reload list to get the new ID
      await loadConversations(db);

      // Query specifically for the latest ID to navigate
      const latestConvo: Conversation[] = await db.select(
        "SELECT id FROM conversations ORDER BY id DESC LIMIT 1"
      );
      if (latestConvo.length > 0) {
          console.log("Navigating to new chat:", latestConvo[0].id);
          navigate(`/chat/${latestConvo[0].id}`);
      } else {
          console.warn("Could not retrieve new conversation ID after creation.");
          await loadConversations(db); // Attempt reload again just in case
      }

    } catch (error: any) {
      console.error("Error creating new conversation:", error);
      setDbError(`Failed to create conversation: ${error?.message || error}`);
    }
  };

  // --- Function to Handle Deleting a Conversation ---
  const handleDeleteConversation = async (conversationId: number) => {
    if (!db) {
      console.error("[Delete] Database not connected.");
      setDbError("Database not connected. Cannot delete chat.");
      return;
    }

    try {

      // 3. Delete associated messages first
      const messagesResult = await db.execute(
          "DELETE FROM chat_messages WHERE conversation_id = $1", // <-- Correct SQL
          [conversationId]
      );
      // 4. Delete the conversation itself
      const conversationResult = await db.execute(
          "DELETE FROM conversations WHERE id = $1", // <-- Correct SQL
          [conversationId]
      );
      // 5. Update frontend state
      setConversations(prevConversations => {
           const newState = prevConversations.filter(c => c.id !== conversationId);
           console.log(`[Delete] New conversations state length: ${newState.length}`);
           return newState;
       });

      // 6. Navigate if necessary
      if (location.pathname === `/chat/${conversationId}`) {
          console.log(`[Delete] Current chat ${conversationId} deleted, navigating to home.`);
          // setLogs(`Navigating home`);
          navigate('/');
      }
      console.log(`[Delete] Deletion process completed successfully for ${conversationId}.`);
      // setLogs(`Deletion complete for ${conversationId}`);
    } catch (error: any) {
      console.error(`[Delete] Error during deletion for ${conversationId}:`, error);
      const errorMsg = `Failed to delete conversation: ${error?.message || error}`;
      setDbError(errorMsg);
    }
  };

  // Simple loading/error display
  if (isDbLoading) {
      return <div className="app-layout"><div>Loading Database...</div></div>;
  }


  return (
    <div className="app-layout"> {/* Use className from App.css */}
      {/* Sidebar */}
      <nav className="sidebar"> {/* Use className */}
        <div className="sidebar-header">
             <img src="/logo.png" alt="Ollamate Logo" className="sidebar-logo" />
        </div>
        <div className="navigation-section">
             <Link to="/" className={`nav-link ${location.pathname === '/' ? 'active' : ''}`}>Home</Link>
             <Link to="/settings" className={`nav-link ${location.pathname === '/settings' ? 'active' : ''}`}>Settings</Link>
        </div>

        <hr style={{ margin: '0 1rem 1rem 1rem', borderColor: 'var(--border-color-light)' }}/>

        <div className="chats-section">
            <button onClick={handleNewChat} disabled={!db}>+ New Chat</button>
            {dbError && <p className="error-message" style={{fontSize: '0.8em', padding: '0 0.5rem'}}>{dbError}</p>}
            <div className="chats-list"> {/* Scrollable list container */}
                {conversations.map((convo) => {
                    const isActive = location.pathname === `/chat/${convo.id}`;
                    return (
                        // Wrapper div for flex layout
                        <div key={convo.id} className="chat-list-item">
                            <Link
                                to={`/chat/${convo.id}`}
                                className={`nav-link chat-link ${isActive ? 'active' : ''}`}
                            >
                                {convo.name}
                            </Link>
                            <button
                                onClick={(e) => {
                                    e.preventDefault();
                                    handleDeleteConversation(convo.id);
                                }}
                                className="delete-chat-btn"
                                title={`Delete ${convo.name}`} // Accessibility
                                disabled={!db} // Disable if DB is not ready
                            >
                                {/* Simple 'X' icon, replace with SVG later if desired */}
                                &times;
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="main-content"> {/* Use className */}
        <Routes>
          <Route path="/" element={<HomePage />} />
          {/* Dynamic route for chat expects conversationId */}
          {/* Pass db instance down as a prop */}
          <Route path="/chat/:conversationId" element={db ? <ChatPage db={db} /> : <p>Database not connected.</p>} />
          <Route path="/settings" element={db ? <SettingsPage db={db} /> : <p>Database not connected.</p>} /> {/* Add Settings route */}
          {/* Add more routes here if needed */}
        </Routes>
      </main>
    </div>
  );
}

export default App;