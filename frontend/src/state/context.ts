import { createContext, useContext } from "react";
import type { EngineHub } from "../engine";
import type { Calculation } from "./calc";

export interface Services {
  hub: EngineHub;
  calc: Calculation;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices() {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("Services are not available");
  return services;
}
