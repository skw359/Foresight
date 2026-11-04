/** App-wide top bar with brand, identity, dev link, and sign-out. */
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { useNavProgressRef } from "../context/navProgress";
import { NavProgress } from "./NavProgress";
import { Icon } from "./Icon";

export function TopBar() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const navProgressRef = useNavProgressRef();

  function handleSignOut() {
    signOut();
    navigate("/login", { replace: true });
  }

  return (
    <div className="topbar">
      <Link to="/" className="brand">
        <span className="mark">
          <img src="/logo.png" alt="" />
        </span>
        Foresight
      </Link>
      <span className="spacer" />
      <Link
        to="/dev/camera"
        className="btn ghost sm"
        title="In-browser test camera"
      >
        <Icon name="camera" size={16} />
        Dev Camera
      </Link>
      {user && <span className="who">{user.identifier}</span>}
      <button className="btn ghost sm" onClick={handleSignOut}>
        <Icon name="signOut" size={16} />
        Sign out
      </button>
      <NavProgress ref={navProgressRef} />
    </div>
  );
}
