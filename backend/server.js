import { useEffect, useState } from "react";

export default function Home() {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    fetch("http://localhost:5000/users")
      .then(res => res.json())
      .then(data => setUsers(data))
      .catch(err => console.log(err));
  }, []);

  return (
    <div>
      <h1>Users from backend</h1>

      {users.length === 0 ? (
        <p>No users yet</p>
      ) : (
        users.map((u, i) => (
          <p key={i}>{u.email}</p>
        ))
      )}
    </div>
  );
}