"use client";
import { useParams } from "next/navigation";
import Room from "../../room";
export default function RoomPage() {
  const params = useParams<{ id: string }>();
  return <Room id={params.id} />;
}
