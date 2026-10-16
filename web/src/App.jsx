import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Approve from "./pages/Approve.jsx";
import MandatePage from "./pages/Mandate.jsx";
import Payees from "./pages/Payees.jsx";
import Guardian from "./pages/Guardian.jsx";
import Ledger from "./pages/Ledger.jsx";
import Verify from "./pages/Verify.jsx";

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/approve/:id" element={<Approve />} />
        <Route path="/mandate" element={<MandatePage />} />
        <Route path="/payees" element={<Payees />} />
        <Route path="/guardian" element={<Guardian />} />
        <Route path="/ledger" element={<Ledger />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/verify/:id" element={<Verify />} />
      </Routes>
    </Layout>
  );
}
