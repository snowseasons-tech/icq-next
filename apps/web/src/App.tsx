import { FormEvent, useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";

const API_URL = (import.meta as any).env?.VITE_API_URL || window.location.origin;
const TOKEN_KEY = "icq-next-token";

type AuthUser = { sub: string; username: string; email: string };
type UserRef = { id: string; username: string };
type Room = {
  id: string;
  name: string;
  kind: "GROUP" | "DIRECT";
  // For direct rooms, the other person from the viewer's side.
  peer: UserRef | null;
  createdAt: string;
};
type ChatMessage = {
  id: string;
  content: string;
  roomId: string;
  createdAt: string;
  sender: { id: string; username: string };
};

function appendUnique(current: ChatMessage[], incoming: ChatMessage) {
  return current.some((item) => item.id === incoming.id) ? current : [...current, incoming];
}

function upsertRoom(current: Room[], room: Room) {
  return current.some((item) => item.id === room.id) ? current : [...current, room];
}

function roomLabel(room: Room) {
  return room.kind === "DIRECT" ? `@${room.peer?.username ?? room.name}` : `# ${room.name}`;
}

const buttonStyle = (active: boolean) => ({
  width: "100%",
  display: "block",
  marginBottom: 8,
  padding: "10px 12px",
  border: active ? "1px solid #74dbff" : "1px solid #26344a",
  borderRadius: 8,
  background: active ? "#152035" : "transparent",
  color: "#edf4ff",
  textAlign: "left" as const,
  cursor: "pointer",
});

const inputStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  padding: 10,
  borderRadius: 8,
  border: "1px solid #46556b",
  background: "#152035",
  color: "#edf4ff",
};

export default function App() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<AuthUser | null>(null);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [dmQuery, setDmQuery] = useState("");
  const [dmResults, setDmResults] = useState<UserRef[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);

  const groupRooms = rooms.filter((room) => room.kind === "GROUP");
  const directRooms = rooms.filter((room) => room.kind === "DIRECT");

  useEffect(() => {
    if (!token) return;
    fetch(`${API_URL}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Session expired");
        const data = await response.json();
        setUser({ sub: data.user.id, username: data.user.username, email: data.user.email });
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
      });
  }, [token]);

  useEffect(() => {
    if (!token || !user) return;
    fetch(`${API_URL}/api/rooms`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load rooms");
        const data = await response.json();
        setRooms(data.rooms);
        setActiveRoom((current) => current || data.rooms[0] || null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load rooms"));
  }, [token, user]);

  useEffect(() => {
    if (!token || !activeRoom) return;
    let stale = false;
    setMessages([]);
    fetch(`${API_URL}/api/rooms/${activeRoom.id}/messages`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load messages");
        const data = await response.json();
        // Ignore history for a room the user has already switched away from.
        if (!stale) setMessages(data.messages);
      })
      .catch((err) => { if (!stale) setError(err instanceof Error ? err.message : "Could not load messages"); });
    return () => { stale = true; };
  }, [token, activeRoom]);

  // People search for starting a direct message (debounced).
  useEffect(() => {
    if (!token) return;
    const query = dmQuery.trim();
    if (!query) { setDmResults([]); return; }
    let stale = false;
    const timer = setTimeout(() => {
      fetch(`${API_URL}/api/users?q=${encodeURIComponent(query)}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(async (response) => {
          if (!response.ok) throw new Error("Could not search people");
          const data = await response.json();
          if (!stale) setDmResults(data.users);
        })
        .catch((err) => { if (!stale) setError(err instanceof Error ? err.message : "Could not search people"); });
    }, 200);
    return () => { stale = true; clearTimeout(timer); };
  }, [token, dmQuery]);

  useEffect(() => {
    if (!token) return;
    const client = io(API_URL, { auth: { token } });
    setSocket(client);
    client.on("socket:error", (payload: { error: string }) => setError(payload.error));
    // New group rooms are announced to everyone; direct rooms only to their members.
    client.on("room:new", (room: Room) => setRooms((current) => upsertRoom(current, room)));
    return () => {
      client.disconnect();
      setSocket(null);
    };
  }, [token]);

  // Joins the active room (again after every reconnect) and only renders messages for that room.
  useEffect(() => {
    if (!socket || !activeRoom) return;
    const roomId = activeRoom.id;
    const join = () => socket.emit("room:join", roomId);
    const onNew = (incoming: ChatMessage) => {
      if (incoming.roomId === roomId) setMessages((current) => appendUnique(current, incoming));
    };
    if (socket.connected) join();
    socket.on("connect", join);
    socket.on("message:new", onNew);
    return () => {
      socket.off("connect", join);
      socket.off("message:new", onNew);
      socket.emit("room:leave", roomId);
    };
  }, [socket, activeRoom]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const body = mode === "register" ? { username, email, password } : { email, password };
      const response = await fetch(`${API_URL}/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Authentication failed");
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setUser(data.user);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setRooms([]);
    setActiveRoom(null);
    setMessages([]);
  }

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setError("");
    const response = await fetch(`${API_URL}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: newRoomName }),
    });
    const data = await response.json();
    if (!response.ok) { setError(data.error || "Could not create room"); return; }
    setRooms((current) => upsertRoom(current, data.room));
    setActiveRoom(data.room);
    setNewRoomName("");
  }

  async function openDirect(peer: UserRef) {
    if (!token) return;
    setError("");
    const response = await fetch(`${API_URL}/api/direct-rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: peer.id }),
    });
    const data = await response.json();
    if (!response.ok) { setError(data.error || "Could not open direct message"); return; }
    setRooms((current) => upsertRoom(current, data.room));
    setActiveRoom(data.room);
    setDmQuery("");
    setDmResults([]);
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!token || !activeRoom || !message.trim()) return;
    setError("");
    const content = message.trim();
    setMessage("");
    if (socket?.connected) {
      socket.emit("message:send", { roomId: activeRoom.id, content });
      return;
    }
    const response = await fetch(`${API_URL}/api/rooms/${activeRoom.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
    });
    const data = await response.json();
    if (!response.ok) { setError(data.error || "Could not send message"); return; }
    setMessages((current) => appendUnique(current, data.message));
  }

  if (user) {
    return (
      <main style={{ height: "100vh", display: "grid", gridTemplateColumns: "260px 1fr", background: "#08111f", color: "#edf4ff", fontFamily: "system-ui" }}>
        <aside style={{ borderRight: "1px solid #26344a", padding: 20, background: "#101a2a", display: "flex", flexDirection: "column", minHeight: 0, overflowY: "auto" }}>
          <p style={{ color: "#74dbff", textTransform: "uppercase", letterSpacing: 2 }}>ICQ Next</p>
          <h2 style={{ margin: "8px 0" }}>{user.username}</h2>
          <p style={{ color: "#b4c3d5", fontSize: 13 }}>{user.email}</p>

          <nav aria-label="Rooms" style={{ marginTop: 24 }}>
            <p style={{ color: "#74dbff", fontSize: 12, letterSpacing: 1, textTransform: "uppercase", margin: "0 0 8px" }}>Rooms</p>
            {groupRooms.map((room) => (
              <button key={room.id} type="button" onClick={() => setActiveRoom(room)} style={buttonStyle(activeRoom?.id === room.id)}>
                {roomLabel(room)}
              </button>
            ))}
          </nav>
          <form onSubmit={createRoom} style={{ marginTop: 8 }}>
            <input aria-label="New room name" value={newRoomName} onChange={(event) => setNewRoomName(event.target.value)} placeholder="New room" style={inputStyle} />
          </form>

          <nav aria-label="Direct messages" style={{ marginTop: 24 }}>
            <p style={{ color: "#74dbff", fontSize: 12, letterSpacing: 1, textTransform: "uppercase", margin: "0 0 8px" }}>Direct messages</p>
            {directRooms.map((room) => (
              <button key={room.id} type="button" onClick={() => setActiveRoom(room)} style={buttonStyle(activeRoom?.id === room.id)}>
                {roomLabel(room)}
              </button>
            ))}
          </nav>
          <div style={{ marginTop: 8 }}>
            <input aria-label="Find someone" value={dmQuery} onChange={(event) => setDmQuery(event.target.value)} placeholder="Message someone…" style={inputStyle} />
            {dmResults.map((person) => (
              <button key={person.id} type="button" onClick={() => openDirect(person)} style={{ ...buttonStyle(false), marginTop: 8 }}>
                @{person.username}
              </button>
            ))}
            {dmQuery.trim() && !dmResults.length && <p style={{ color: "#b4c3d5", fontSize: 13 }}>No matching people.</p>}
          </div>

          <button type="button" onClick={logout} style={{ marginTop: "auto", padding: "10px 16px", border: 0, borderRadius: 8, background: "#74dbff", color: "#061223", fontWeight: 700 }}>
            Sign out
          </button>
        </aside>
        <section style={{ minWidth: 0, display: "grid", gridTemplateRows: "72px 1fr 76px" }}>
          <header style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #26344a", padding: "0 24px" }}>
            <h1 style={{ fontSize: 20, margin: 0 }}>{activeRoom ? roomLabel(activeRoom) : "Select a room"}</h1>
          </header>
          <div aria-live="polite" style={{ overflowY: "auto", padding: 24 }}>
            {messages.map((item) => (
              <article key={item.id} style={{ marginBottom: 16 }}>
                <strong style={{ color: item.sender.id === user.sub ? "#74dbff" : "#ffc46b" }}>{item.sender.username}</strong>
                <span style={{ color: "#b4c3d5", fontSize: 12, marginLeft: 8 }}>{new Date(item.createdAt).toLocaleTimeString()}</span>
                <p style={{ margin: "4px 0 0", lineHeight: 1.5 }}>{item.content}</p>
              </article>
            ))}
            {!messages.length && <p style={{ color: "#b4c3d5" }}>No messages yet. Start the conversation.</p>}
          </div>
          <form onSubmit={sendMessage} style={{ display: "flex", gap: 10, alignItems: "center", borderTop: "1px solid #26344a", padding: "12px 24px" }}>
            <input aria-label="Message" value={message} onChange={(event) => setMessage(event.target.value)} disabled={!activeRoom} placeholder={activeRoom ? `Message ${roomLabel(activeRoom)}` : "Select a room"} style={{ flex: 1, padding: 12, borderRadius: 8, border: "1px solid #46556b", background: "#152035", color: "#edf4ff" }} />
            <button disabled={!activeRoom || !message.trim()} type="submit" style={{ padding: "12px 16px", border: 0, borderRadius: 8, background: "#74dbff", color: "#061223", fontWeight: 700 }}>Send</button>
          </form>
        </section>
        {error && <p role="alert" style={{ position: "fixed", right: 20, bottom: 20, margin: 0, padding: "10px 14px", borderRadius: 8, background: "#7f1d1d", color: "#fff" }}>{error}</p>}
      </main>
    );
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#08111f", color: "#edf4ff", fontFamily: "system-ui" }}>
      <form onSubmit={submit} style={{ width: "min(420px, calc(100vw - 32px))", border: "1px solid #26344a", borderRadius: 16, padding: 32, background: "#101a2a" }}>
        <p style={{ color: "#74dbff", letterSpacing: 2 }}>ICQ NEXT</p>
        <h1>{mode === "login" ? "Sign in" : "Create account"}</h1>
        {mode === "register" && (
          <label style={{ display: "block", marginTop: 16 }}>
            Username
            <input required value={username} onChange={(event) => setUsername(event.target.value)} style={{ display: "block", width: "100%", marginTop: 6, padding: 12, borderRadius: 8, border: "1px solid #46556b", background: "#152035", color: "#edf4ff" }} />
          </label>
        )}
        <label style={{ display: "block", marginTop: 16 }}>
          Email
          <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} style={{ display: "block", width: "100%", marginTop: 6, padding: 12, borderRadius: 8, border: "1px solid #46556b", background: "#152035", color: "#edf4ff" }} />
        </label>
        <label style={{ display: "block", marginTop: 16 }}>
          Password
          <input required type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} style={{ display: "block", width: "100%", marginTop: 6, padding: 12, borderRadius: 8, border: "1px solid #46556b", background: "#152035", color: "#edf4ff" }} />
        </label>
        {error && <p role="alert" style={{ color: "#ff8fa3", marginBottom: 0 }}>{error}</p>}
        <button disabled={loading} type="submit" style={{ width: "100%", marginTop: 20, padding: "12px 16px", border: 0, borderRadius: 8, background: "#74dbff", color: "#061223", fontWeight: 700 }}>
          {loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }} style={{ width: "100%", marginTop: 10, padding: 10, border: "1px solid #46556b", borderRadius: 8, background: "transparent", color: "#edf4ff" }}>
          {mode === "login" ? "Need an account? Register" : "Already registered? Sign in"}
        </button>
      </form>
    </main>
  );
}
