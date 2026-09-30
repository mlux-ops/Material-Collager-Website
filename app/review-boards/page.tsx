"use client";

import { ReviewBoards } from "../components/review-boards/ReviewBoards";
import { RouteReady } from "../components/RouteReady";

export default function ReviewBoardsPage() {
  return (
    <>
      <RouteReady path="/review-boards" />
      <ReviewBoards />
    </>
  );
}
