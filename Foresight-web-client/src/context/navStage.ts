import { createContext, useContext } from "react";

export const NavStageContext = createContext<"in" | "out">("in");
export const useNavStage = () => useContext(NavStageContext);
