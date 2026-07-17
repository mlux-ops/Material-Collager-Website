"use client";

import { useEffect, useRef, type RefObject } from "react";

const CENTER_FRACTION = 0.5;
const EDGE_FRACTION = 0.12;

export function useNativeScrollProgress(trackRef: RefObject<HTMLElement | null>) {
  const target = useRef(0);

  useEffect(() => {
    let frame = 0;
    let lastScrollY = window.scrollY;
    let recenter