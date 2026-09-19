/** pavsa freq-europe.csv (EFIS ECA), только пересечение с RX xA4 70–6000 МГц. */
export interface AllocBand { f1Mhz: number; f2Mhz: number; name: string; applications: string }
export const FREQ_EUROPE_XA4: readonly AllocBand[] = [
  {
    "f1Mhz": 100.0,
    "f2Mhz": 108.0,
    "name": "Broadcasting",
    "applications": "FM sound analogue/Wireless audio/multimedia"
  },
  {
    "f1Mhz": 108.0,
    "f2Mhz": 117.975,
    "name": "Aeronautical Radionavigation/Aeronautical Mobile (R)",
    "applications": "Aeronautical communications/ILS/VOR/GBAS"
  },
  {
    "f1Mhz": 117.975,
    "f2Mhz": 121.45,
    "name": "Aeronautical Mobile-Satellite (R)",
    "applications": "Aeronautical communications"
  },
  {
    "f1Mhz": 121.45,
    "f2Mhz": 121.55,
    "name": "Aeronautical Mobile (R)",
    "applications": "EPIRBs/-"
  },
  {
    "f1Mhz": 121.55,
    "f2Mhz": 136.0,
    "name": "Aeronautical Mobile (R)",
    "applications": "Aeronautical communications"
  },
  {
    "f1Mhz": 136.0,
    "f2Mhz": 137.0,
    "name": "Aeronautical Mobile (R)",
    "applications": "Aeronautical communications"
  },
  {
    "f1Mhz": 137.0,
    "f2Mhz": 137.025,
    "name": "Meteorological-Satellite (space-to-Earth)/Mobile/Mobile-Satellite (space-to-Earth)/Space Operation (space-to-Earth)/Space Research (space-to-Earth)",
    "applications": "S-PCS/Weather satellites/Land mobile/Land military systems/Satellite systems (military)/Aeronautical military systems"
  },
  {
    "f1Mhz": 137.025,
    "f2Mhz": 137.175,
    "name": "Meteorological-Satellite (space-to-Earth)/Mobile/Mobile-Satellite (space-to-Earth)/Space Operation (space-to-Earth)/Space Research (space-to-Earth)",
    "applications": "Land military systems/Satellite systems (military)/Aeronautical military systems/S-PCS/Weather satellites/Land mobile"
  },
  {
    "f1Mhz": 137.175,
    "f2Mhz": 137.825,
    "name": "Meteorological-Satellite (space-to-Earth)/Mobile/Mobile-Satellite (space-to-Earth)/Space Operation (space-to-Earth)/Space Research (space-to-Earth)",
    "applications": "S-PCS/Weather satellites/Land mobile/Land military systems/Satellite systems (military)/Aeronautical military systems"
  },
  {
    "f1Mhz": 137.825,
    "f2Mhz": 138.0,
    "name": "Meteorological-Satellite (space-to-Earth)/Mobile/Mobile-Satellite (space-to-Earth)/Space Operation (space-to-Earth)/Space Research (space-to-Earth)",
    "applications": "Land military systems/Satellite systems (military)/Aeronautical military systems/S-PCS/Weather satellites/Land mobile"
  },
  {
    "f1Mhz": 138.0,
    "f2Mhz": 143.6,
    "name": "Aeronautical Mobile (OR)/Land Mobile/Space Research (space-to-Earth)",
    "applications": "Land mobile/Non-specific SRDs/Land military systems/Aeronautical military systems/Maritime military systems"
  },
  {
    "f1Mhz": 143.6,
    "f2Mhz": 143.65,
    "name": "Aeronautical Mobile (OR)/Land Mobile/Space Research (space-to-Earth)",
    "applications": "Land military systems/Aeronautical military systems/Maritime military systems/Land mobile"
  },
  {
    "f1Mhz": 143.65,
    "f2Mhz": 144.0,
    "name": "Aeronautical Mobile (OR)/Land Mobile",
    "applications": "Land mobile/Land military systems/Aeronautical military systems/Maritime military systems"
  },
  {
    "f1Mhz": 144.0,
    "f2Mhz": 146.0,
    "name": "Amateur/Amateur-Satellite",
    "applications": "Amateur/Amateur-satellite"
  },
  {
    "f1Mhz": 146.0,
    "f2Mhz": 148.0,
    "name": "Mobile",
    "applications": "PMR/PAMR"
  },
  {
    "f1Mhz": 148.0,
    "f2Mhz": 149.9,
    "name": "Mobile/Mobile-Satellite (Earth-to-space)",
    "applications": "S-PCS/PMR/PAMR"
  },
  {
    "f1Mhz": 149.9,
    "f2Mhz": 150.05,
    "name": "Mobile/Mobile-Satellite (Earth-to-space)",
    "applications": "S-PCS/PMR/PAMR"
  },
  {
    "f1Mhz": 150.05,
    "f2Mhz": 153.0,
    "name": "Mobile except aeronautical mobile/Radio Astronomy",
    "applications": "PMR/PAMR/Radio astronomy"
  },
  {
    "f1Mhz": 153.0,
    "f2Mhz": 154.0,
    "name": "Mobile except aeronautical mobile (R)",
    "applications": "PMR/PAMR"
  },
  {
    "f1Mhz": 154.0,
    "f2Mhz": 156.4875,
    "name": "Mobile except aeronautical mobile (R)",
    "applications": "PMR/PAMR/Maritime communications"
  },
  {
    "f1Mhz": 156.4875,
    "f2Mhz": 156.5125,
    "name": "Maritime Mobile (distress and calling via DSC)",
    "applications": "Maritime communications"
  },
  {
    "f1Mhz": 156.5125,
    "f2Mhz": 156.5375,
    "name": "Maritime Mobile (distress and calling via DSC)",
    "applications": "DSC"
  },
  {
    "f1Mhz": 156.5375,
    "f2Mhz": 156.5625,
    "name": "Maritime Mobile (distress and calling via DSC)/Mobile except aeronautical mobile (R)",
    "applications": "Maritime communications"
  },
  {
    "f1Mhz": 156.5625,
    "f2Mhz": 156.7625,
    "name": "Mobile except aeronautical mobile (R)",
    "applications": "Maritime communications"
  },
  {
    "f1Mhz": 156.7625,
    "f2Mhz": 156.7875,
    "name": "Maritime Mobile (distress and calling)",
    "applications": "Maritime communications"
  },
  {
    "f1Mhz": 156.7875,
    "f2Mhz": 156.8125,
    "name": "Maritime Mobile (distress and calling)",
    "applications": "Maritime communications"
  },
  {
    "f1Mhz": 156.8125,
    "f2Mhz": 156.8375,
    "name": "Maritime Mobile",
    "applications": "Maritime communications"
  },
  {
    "f1Mhz": 156.8375,
    "f2Mhz": 161.9375,
    "name": "Mobile except aeronautical mobile",
    "applications": "Maritime communications/PMR/PAMR"
  },
  {
    "f1Mhz": 161.9375,
    "f2Mhz": 161.9625,
    "name": "Mobile except aeronautical mobile/Maritime Mobile-Satellite (Earth-to-space)",
    "applications": "Maritime communications/PMR/PAMR"
  },
  {
    "f1Mhz": 161.9875,
    "f2Mhz": 162.0125,
    "name": "Mobile except aeronautical mobile/Maritime Mobile-Satellite (Earth-to-space)",
    "applications": "Maritime communications"
  },
  {
    "f1Mhz": 162.0125,
    "f2Mhz": 162.0375,
    "name": "Mobile except aeronautical mobile",
    "applications": "Maritime communications/AIS"
  },
  {
    "f1Mhz": 162.0375,
    "f2Mhz": 169.4,
    "name": "Mobile except aeronautical mobile",
    "applications": "PMR/PAMR"
  },
  {
    "f1Mhz": 169.4,
    "f2Mhz": 169.8125,
    "name": "Mobile except aeronautical mobile",
    "applications": "Aids for hearing impaired/Meter reading/Non-specific SRDs"
  },
  {
    "f1Mhz": 169.8125,
    "f2Mhz": 174.0,
    "name": "Mobile except aeronautical mobile",
    "applications": "Radio microphones and ALD/PMR/PAMR/Aids for hearing impaired"
  },
  {
    "f1Mhz": 174.0,
    "f2Mhz": 223.0,
    "name": "Broadcasting/Land Mobile",
    "applications": "PMSE/Radio microphones and ALD/Broadcasting (terrestrial)"
  },
  {
    "f1Mhz": 223.0,
    "f2Mhz": 225.0,
    "name": "Broadcasting",
    "applications": "Broadcasting (terrestrial)"
  },
  {
    "f1Mhz": 225.0,
    "f2Mhz": 230.0,
    "name": "Broadcasting/Land Mobile",
    "applications": "Broadcasting (terrestrial)/Defence systems"
  },
  {
    "f1Mhz": 230.0,
    "f2Mhz": 235.0,
    "name": "Mobile",
    "applications": "Defence systems/T-DAB"
  },
  {
    "f1Mhz": 235.0,
    "f2Mhz": 240.0,
    "name": "Mobile",
    "applications": "Defence systems/T-DAB"
  },
  {
    "f1Mhz": 240.0,
    "f2Mhz": 242.95,
    "name": "Mobile",
    "applications": "Defence systems"
  },
  {
    "f1Mhz": 242.95,
    "f2Mhz": 243.05,
    "name": "Aeronautical Mobile",
    "applications": "EPIRBs"
  },
  {
    "f1Mhz": 243.05,
    "f2Mhz": 267.0,
    "name": "Mobile",
    "applications": "Defence systems"
  },
  {
    "f1Mhz": 267.0,
    "f2Mhz": 272.0,
    "name": "Mobile",
    "applications": "Defence systems"
  },
  {
    "f1Mhz": 272.0,
    "f2Mhz": 273.0,
    "name": "Mobile",
    "applications": "Defence systems"
  },
  {
    "f1Mhz": 273.0,
    "f2Mhz": 312.0,
    "name": "Mobile",
    "applications": "Defence systems"
  },
  {
    "f1Mhz": 312.0,
    "f2Mhz": 315.0,
    "name": "Mobile",
    "applications": "Defence systems"
  },
  {
    "f1Mhz": 315.0,
    "f2Mhz": 322.0,
    "name": "Mobile",
    "applications": "Defence systems"
  },
  {
    "f1Mhz": 322.0,
    "f2Mhz": 328.6,
    "name": "Mobile/Radio Astronomy",
    "applications": "Defence systems/Radio astronomy"
  },
  {
    "f1Mhz": 328.6,
    "f2Mhz": 335.4,
    "name": "Aeronautical Radionavigation",
    "applications": "ILS"
  },
  {
    "f1Mhz": 380.0,
    "f2Mhz": 385.0,
    "name": "Mobile",
    "applications": "Defence systems/PPDR"
  },
  {
    "f1Mhz": 385.0,
    "f2Mhz": 387.0,
    "name": "Mobile",
    "applications": "Defence systems/PMR/PAMR"
  },
  {
    "f1Mhz": 387.0,
    "f2Mhz": 390.0,
    "name": "Mobile",
    "applications": "Defence systems/PMR/PAMR"
  },
  {
    "f1Mhz": 390.0,
    "f2Mhz": 395.0,
    "name": "Mobile",
    "applications": "Defence systems/PPDR"
  },
  {
    "f1Mhz": 395.0,
    "f2Mhz": 399.9,
    "name": "Mobile",
    "applications": "Defence systems/PMR/PAMR"
  },
  {
    "f1Mhz": 399.9,
    "f2Mhz": 400.05,
    "name": "Mobile-Satellite (Earth-to-space)",
    "applications": "PPDR"
  },
  {
    "f1Mhz": 400.05,
    "f2Mhz": 400.15,
    "name": "Standard frequency and time signal-satellite (400.1 MHz)",
    "applications": "PPDR"
  },
  {
    "f1Mhz": 400.15,
    "f2Mhz": 401.0,
    "name": "Meteorological Aids/Meteorological-Satellite (space-to-Earth)/Mobile-Satellite (space-to-Earth)/Space Research (space-to-Earth)/Space Operation (space-to-Earth)",
    "applications": "PPDR/Sondes/Weather satellites/S-PCS"
  },
  {
    "f1Mhz": 401.0,
    "f2Mhz": 402.0,
    "name": "Earth Exploration-Satellite (Earth-to-space)/Meteorological Aids/Meteorological-Satellite (Earth-to-space)",
    "applications": "Sondes/Weather satellites/Active medical implants"
  },
  {
    "f1Mhz": 402.0,
    "f2Mhz": 403.0,
    "name": "Earth Exploration-Satellite (Earth-to-space)/Meteorological Aids/Meteorological-Satellite (Earth-to-space)",
    "applications": "Sondes/Active medical implants/Weather satellites"
  },
  {
    "f1Mhz": 403.0,
    "f2Mhz": 406.0,
    "name": "Meteorological Aids",
    "applications": "Sondes/Active medical implants"
  },
  {
    "f1Mhz": 406.0,
    "f2Mhz": 406.1,
    "name": "Mobile-Satellite (Earth-to-space)",
    "applications": "EPIRBs"
  },
  {
    "f1Mhz": 406.1,
    "f2Mhz": 410.0,
    "name": "Land Mobile/Radio Astronomy",
    "applications": "PMR/PAMR/Radio astronomy/Land military systems/Maritime military systems"
  },
  {
    "f1Mhz": 410.0,
    "f2Mhz": 420.0,
    "name": "Mobile except aeronautical mobile",
    "applications": "Land military systems/Maritime military systems/PMR/PAMR"
  },
  {
    "f1Mhz": 420.0,
    "f2Mhz": 430.0,
    "name": "Mobile except aeronautical mobile/Radiolocation",
    "applications": "PMR/PAMR/Land military systems/Maritime military systems/Radiolocation (military)"
  },
  {
    "f1Mhz": 430.0,
    "f2Mhz": 432.0,
    "name": "Amateur/Radiolocation",
    "applications": "Radiolocation (military)/ULP-WMCE/Amateur"
  },
  {
    "f1Mhz": 432.0,
    "f2Mhz": 433.05,
    "name": "Amateur/Radiolocation/Earth Exploration-Satellite (active)",
    "applications": "Active sensors (satellite)/Amateur/ULP-WMCE/Radiolocation (military)"
  },
  {
    "f1Mhz": 433.05,
    "f2Mhz": 434.79,
    "name": "Amateur/Radiolocation/Land Mobile/Earth Exploration-Satellite (active)",
    "applications": "Radiolocation (military)/ULP-WMCE/Amateur/ISM/Non-specific SRDs/Active sensors (satellite)"
  },
  {
    "f1Mhz": 434.79,
    "f2Mhz": 438.0,
    "name": "Amateur/Amateur-Satellite/Radiolocation/Earth Exploration-Satellite (active)",
    "applications": "Amateur/Amateur-satellite/Active sensors (satellite)/ULP-WMCE/Radiolocation (military)"
  },
  {
    "f1Mhz": 438.0,
    "f2Mhz": 440.0,
    "name": "Amateur/Radiolocation",
    "applications": "Radiolocation (military)/ULP-WMCE/Amateur"
  },
  {
    "f1Mhz": 440.0,
    "f2Mhz": 450.0,
    "name": "Mobile except aeronautical mobile/Radiolocation",
    "applications": "Wind profilers/On-site paging/PMR 446/PMR/PAMR/Land military systems/Maritime military systems/Radiolocation (military)"
  },
  {
    "f1Mhz": 450.0,
    "f2Mhz": 455.0,
    "name": "Mobile",
    "applications": "On-site paging/PMR/PAMR"
  },
  {
    "f1Mhz": 455.0,
    "f2Mhz": 456.0,
    "name": "Mobile",
    "applications": "Land mobile/On-site paging/PMR/PAMR"
  },
  {
    "f1Mhz": 456.0,
    "f2Mhz": 459.0,
    "name": "Mobile",
    "applications": "Land mobile/On-board communications/PMR/PAMR/On-site paging"
  },
  {
    "f1Mhz": 459.0,
    "f2Mhz": 460.0,
    "name": "Mobile",
    "applications": "Land mobile/On-site paging/PMR/PAMR"
  },
  {
    "f1Mhz": 460.0,
    "f2Mhz": 470.0,
    "name": "Mobile",
    "applications": "Land mobile/On-board communications/PMR/PAMR/On-site paging/Space research/Meteorological aids (military)"
  },
  {
    "f1Mhz": 470.0,
    "f2Mhz": 694.0,
    "name": "Broadcasting",
    "applications": "Radio microphones and ALD/PMSE/Broadcasting (terrestrial)/Wind profilers/Radio astronomy"
  },
  {
    "f1Mhz": 694.0,
    "f2Mhz": 790.0,
    "name": "Broadcasting/Mobile except aeronautical mobile",
    "applications": "Radio microphones and ALD/PMSE/Broadcasting (terrestrial)/MFCN/PPDR"
  },
  {
    "f1Mhz": 790.0,
    "f2Mhz": 862.0,
    "name": "Mobile except aeronautical mobile/Broadcasting",
    "applications": "MFCN/-/Radio microphones and ALD/Broadcasting (terrestrial)"
  },
  {
    "f1Mhz": 862.0,
    "f2Mhz": 870.0,
    "name": "Mobile",
    "applications": "Radio microphones and ALD/Alarms/Non-specific SRDs/RFID/Tracking, tracing and data acquisition/-/Maritime military systems/Land military systems/Wideband data transmission systems"
  },
  {
    "f1Mhz": 870.0,
    "f2Mhz": 876.0,
    "name": "Mobile",
    "applications": "-/Land military systems/Maritime military systems/Non-specific SRDs/PMR/PAMR/Tracking, tracing and data acquisition"
  },
  {
    "f1Mhz": 876.0,
    "f2Mhz": 880.0,
    "name": "Mobile",
    "applications": "-/Land military systems/Maritime military systems/GSM-R"
  },
  {
    "f1Mhz": 880.0,
    "f2Mhz": 890.0,
    "name": "Mobile",
    "applications": "GSM/MCV/IMT"
  },
  {
    "f1Mhz": 890.0,
    "f2Mhz": 915.0,
    "name": "Mobile/Radiolocation",
    "applications": "IMT/MCV/GSM/Land military systems/Maritime military systems"
  },
  {
    "f1Mhz": 915.0,
    "f2Mhz": 921.0,
    "name": "Mobile/Radiolocation",
    "applications": "Maritime military systems/Land military systems/PMR/PAMR/-/Non-specific SRDs/RFID"
  },
  {
    "f1Mhz": 921.0,
    "f2Mhz": 925.0,
    "name": "Mobile/Radiolocation",
    "applications": "GSM-R/Land military systems/Maritime military systems/-"
  },
  {
    "f1Mhz": 925.0,
    "f2Mhz": 942.0,
    "name": "Radiolocation/Mobile",
    "applications": "GSM/IMT/MCV/Land military systems/Maritime military systems"
  },
  {
    "f1Mhz": 942.0,
    "f2Mhz": 960.0,
    "name": "Mobile",
    "applications": "GSM/IMT/MCV"
  },
  {
    "f1Mhz": 960.0,
    "f2Mhz": 1164.0,
    "name": "Aeronautical Radionavigation/Aeronautical Mobile-Satellite (R)/Aeronautical Mobile (R)",
    "applications": "Aeronautical/Aeronautical military systems"
  },
  {
    "f1Mhz": 1164.0,
    "f2Mhz": 1215.0,
    "name": "Aeronautical Radionavigation/Radionavigation-Satellite (space-to-Earth) (space-to-space)",
    "applications": "Aeronautical military systems/Satellite systems (military)/GALILEO/Aeronautical navigation/GNSS Repeater/GLONASS"
  },
  {
    "f1Mhz": 1215.0,
    "f2Mhz": 1240.0,
    "name": "Earth Exploration-Satellite (active)/Radiolocation/Radionavigation-Satellite (space-to-Earth) (space-to-space)/Space Research (active)",
    "applications": "GLONASS/GNSS Repeater/GPS/Radiolocation (civil)/Active sensors (satellite)/Satellite systems (military)/Radiolocation (military)"
  },
  {
    "f1Mhz": 1240.0,
    "f2Mhz": 1300.0,
    "name": "Earth Exploration-Satellite (active)/Radionavigation-Satellite (space-to-Earth) (space-to-space)/Radiolocation/Space Research (active)/Amateur/Amateur-Satellite",
    "applications": "Radiolocation (military)/Satellite systems (military)/Amateur-satellite/GALILEO/Wind profilers/Amateur/GLONASS/Radiolocation (civil)/Active sensors (satellite)/GNSS Repeater"
  },
  {
    "f1Mhz": 1300.0,
    "f2Mhz": 1350.0,
    "name": "Aeronautical Radionavigation/Radiolocation/Radionavigation-Satellite (Earth-to-space)",
    "applications": "Satellite navigation systems/Radiolocation (civil)/Radio astronomy/Satellite systems (military)/Radiolocation (military)"
  },
  {
    "f1Mhz": 1350.0,
    "f2Mhz": 1400.0,
    "name": "Fixed/Mobile/Radiolocation",
    "applications": "Land military systems/Maritime military systems/Aeronautical military systems/Radiolocation (military)/Radio microphones and ALD/Fixed/Radio astronomy"
  },
  {
    "f1Mhz": 1400.0,
    "f2Mhz": 1427.0,
    "name": "Earth Exploration-Satellite (passive)/Radio Astronomy/Space Research (passive)",
    "applications": "Passive sensors (satellite)/Radio astronomy"
  },
  {
    "f1Mhz": 1427.0,
    "f2Mhz": 1429.0,
    "name": "Fixed/Mobile except aeronautical mobile/Space Operation (Earth-to-space)",
    "applications": "Fixed/MFCN/Maritime military systems/Land military systems"
  },
  {
    "f1Mhz": 1429.0,
    "f2Mhz": 1452.0,
    "name": "Fixed/Mobile except aeronautical mobile",
    "applications": "Land military systems/Maritime military systems/MFCN/Fixed"
  },
  {
    "f1Mhz": 1452.0,
    "f2Mhz": 1492.0,
    "name": "Broadcasting/Fixed/Mobile except aeronautical mobile",
    "applications": "T-DAB/MFCN"
  },
  {
    "f1Mhz": 1492.0,
    "f2Mhz": 1518.0,
    "name": "Fixed/Mobile except aeronautical mobile",
    "applications": "Fixed/MFCN/Maritime military systems/Land military systems/Radio microphones and ALD"
  },
  {
    "f1Mhz": 1518.0,
    "f2Mhz": 1525.0,
    "name": "Fixed/Mobile except aeronautical mobile/Mobile-Satellite (space-to-Earth)",
    "applications": "Maritime military systems/Land military systems/Radio microphones and ALD/MSS Earth stations/Fixed/IMT-2000 satellite component"
  },
  {
    "f1Mhz": 1525.0,
    "f2Mhz": 1530.0,
    "name": "Fixed/Mobile-Satellite (space-to-Earth)/Space Operation (space-to-Earth)",
    "applications": "IMT-2000 satellite component/MSS Earth stations/Fixed"
  },
  {
    "f1Mhz": 1530.0,
    "f2Mhz": 1535.0,
    "name": "Mobile-Satellite (space-to-Earth)/Space Operation (space-to-Earth)/Earth Exploration-Satellite/Fixed/Mobile except aeronautical mobile (R)",
    "applications": "IMT-2000 satellite component/MSS Earth stations"
  },
  {
    "f1Mhz": 1535.0,
    "f2Mhz": 1559.0,
    "name": "Mobile-Satellite (space-to-Earth)",
    "applications": "MSS Earth stations/IMT-2000 satellite component"
  },
  {
    "f1Mhz": 1559.0,
    "f2Mhz": 1610.0,
    "name": "Aeronautical Radionavigation/Radionavigation-Satellite (space-to-Earth)/Radionavigation-Satellite (space-to-space)",
    "applications": "GNSS Pseudolites/GNSS Repeater/GALILEO/GLONASS/GPS"
  },
  {
    "f1Mhz": 1610.0,
    "f2Mhz": 1610.6,
    "name": "Aeronautical Radionavigation/Mobile-Satellite (Earth-to-space)",
    "applications": "MSS Earth stations/IMT-2000 satellite component/GLONASS"
  },
  {
    "f1Mhz": 1610.6,
    "f2Mhz": 1613.8,
    "name": "Aeronautical Radionavigation/Mobile-Satellite (Earth-to-space)/Radio Astronomy",
    "applications": "IMT-2000 satellite component/MSS Earth stations/Radio astronomy"
  },
  {
    "f1Mhz": 1613.8,
    "f2Mhz": 1626.5,
    "name": "Aeronautical Radionavigation/Mobile-Satellite (Earth-to-space)/Mobile-Satellite (space-to-Earth)",
    "applications": "MSS Earth stations/IMT-2000 satellite component"
  },
  {
    "f1Mhz": 1626.5,
    "f2Mhz": 1660.0,
    "name": "Mobile-Satellite (Earth-to-space)",
    "applications": "IMT-2000 satellite component/MSS Earth stations"
  },
  {
    "f1Mhz": 1660.0,
    "f2Mhz": 1660.5,
    "name": "Mobile-Satellite (Earth-to-space)/Radio Astronomy",
    "applications": "MSS Earth stations/Radio astronomy/IMT-2000 satellite component"
  },
  {
    "f1Mhz": 1660.5,
    "f2Mhz": 1668.0,
    "name": "Radio Astronomy/Space Research (passive)/Fixed/Mobile except aeronautical mobile",
    "applications": "Radio astronomy"
  },
  {
    "f1Mhz": 1668.0,
    "f2Mhz": 1668.4,
    "name": "Mobile-Satellite (Earth-to-space)/Radio Astronomy/Space Research (passive)/Fixed/Mobile except aeronautical mobile",
    "applications": "Radio astronomy/IMT-2000 satellite component"
  },
  {
    "f1Mhz": 1668.4,
    "f2Mhz": 1670.0,
    "name": "Fixed/Meteorological Aids/Mobile except aeronautical mobile/Mobile-Satellite (Earth-to-space)/Radio Astronomy",
    "applications": "IMT-2000 satellite component/Meteorology/Radio astronomy"
  },
  {
    "f1Mhz": 1670.0,
    "f2Mhz": 1675.0,
    "name": "Meteorological Aids/Meteorological-Satellite (space-to-Earth)/Mobile/Mobile-Satellite (Earth-to-space)/Fixed",
    "applications": "Weather satellites/MSS Earth stations/IMT-2000 satellite component/Meteorology"
  },
  {
    "f1Mhz": 1675.0,
    "f2Mhz": 1690.0,
    "name": "Fixed/Meteorological Aids/Meteorological-Satellite (space-to-Earth)/Mobile except aeronautical mobile",
    "applications": "Land military systems/Maritime military systems/Meteorological aids (military)/Sondes/Weather satellites"
  },
  {
    "f1Mhz": 1690.0,
    "f2Mhz": 1700.0,
    "name": "Meteorological Aids/Meteorological-Satellite (space-to-Earth)/Fixed/Mobile except aeronautical mobile",
    "applications": "Weather satellites/Land military systems/Meteorological aids (military)/Maritime military systems"
  },
  {
    "f1Mhz": 1700.0,
    "f2Mhz": 1710.0,
    "name": "Fixed/Meteorological-Satellite (space-to-Earth)/Mobile except aeronautical mobile",
    "applications": "Land military systems/Maritime military systems/Meteorological aids (military)/Weather satellites"
  },
  {
    "f1Mhz": 1710.0,
    "f2Mhz": 1785.0,
    "name": "Fixed/Mobile",
    "applications": "GSM/Radio astronomy/IMT/MCV/MCA"
  },
  {
    "f1Mhz": 1785.0,
    "f2Mhz": 1800.0,
    "name": "Fixed/Mobile",
    "applications": "-/Land mobile/Radio microphones and ALD/Land military systems"
  },
  {
    "f1Mhz": 1800.0,
    "f2Mhz": 1805.0,
    "name": "Mobile/Fixed",
    "applications": "Land military systems/Radio microphones and ALD/-"
  },
  {
    "f1Mhz": 1805.0,
    "f2Mhz": 1880.0,
    "name": "Fixed/Mobile",
    "applications": "MCA/MCV/IMT/GSM"
  },
  {
    "f1Mhz": 1880.0,
    "f2Mhz": 1885.0,
    "name": "Mobile/Fixed",
    "applications": "DECT"
  },
  {
    "f1Mhz": 1885.0,
    "f2Mhz": 1900.0,
    "name": "Mobile/Fixed",
    "applications": "DECT"
  },
  {
    "f1Mhz": 1900.0,
    "f2Mhz": 1930.0,
    "name": "Mobile/Fixed",
    "applications": "MCA/-/MFCN/MCV/DA2GC"
  },
  {
    "f1Mhz": 1930.0,
    "f2Mhz": 1970.0,
    "name": "Fixed/Mobile",
    "applications": "MFCN/MCV/-/MCA"
  },
  {
    "f1Mhz": 1970.0,
    "f2Mhz": 1980.0,
    "name": "Mobile/Fixed",
    "applications": "MCA/-/MFCN/MCV"
  },
  {
    "f1Mhz": 1980.0,
    "f2Mhz": 2010.0,
    "name": "Mobile/Mobile-Satellite (Earth-to-space)",
    "applications": "-/MSS Earth stations"
  },
  {
    "f1Mhz": 2010.0,
    "f2Mhz": 2025.0,
    "name": "Mobile/Fixed",
    "applications": "IMT/-/PMSE"
  },
  {
    "f1Mhz": 2025.0,
    "f2Mhz": 2110.0,
    "name": "Earth Exploration-Satellite (Earth-to-space) (space-to-space)/Fixed/Mobile/Space Operation (Earth-to-space) (space-to-space)/Space Research (Earth-to-space) (space-to-space)",
    "applications": "Land military systems/Telemetry/Telecommand (military)/Aeronautical military systems/Maritime military systems/Fixed/PMSE/Space research"
  },
  {
    "f1Mhz": 2110.0,
    "f2Mhz": 2120.0,
    "name": "Mobile/Space Research (deep space) (Earth-to-space)/Fixed",
    "applications": "-/MCA/MFCN/MCV"
  },
  {
    "f1Mhz": 2120.0,
    "f2Mhz": 2170.0,
    "name": "Mobile/Fixed",
    "applications": "MFCN/MCV/MCA/-"
  },
  {
    "f1Mhz": 2170.0,
    "f2Mhz": 2200.0,
    "name": "Mobile/Mobile-Satellite (space-to-Earth)",
    "applications": "-/MSS Earth stations"
  },
  {
    "f1Mhz": 2200.0,
    "f2Mhz": 2290.0,
    "name": "Fixed/Mobile/Space Operation (space-to-Earth) (space-to-space)/Space Research (space-to-Earth) (space-to-space)/Earth Exploration-Satellite (space-to-Earth) (space-to-space)",
    "applications": "Fixed/Radio astronomy/Space research/PMSE/Land military systems/Telemetry/Telecommand (military)/Aeronautical military systems/Maritime military systems"
  },
  {
    "f1Mhz": 2290.0,
    "f2Mhz": 2300.0,
    "name": "Fixed/Mobile except aeronautical mobile/Space Research (deep space) (space-to-Earth)",
    "applications": "PMSE/Land mobile/Space research"
  },
  {
    "f1Mhz": 2300.0,
    "f2Mhz": 2400.0,
    "name": "Fixed/Mobile/Amateur/Radiolocation",
    "applications": "Aeronautical telemetry/Amateur/PMSE/MFCN/Land military systems/Telemetry/Telecommand (military)/Aeronautical military systems/Maritime military systems"
  },
  {
    "f1Mhz": 2400.0,
    "f2Mhz": 2450.0,
    "name": "Fixed/Mobile/Amateur-Satellite/Radiolocation/Amateur",
    "applications": "PMSE/Radiodetermination applications/Amateur/Amateur-satellite/ISM/Non-specific SRDs/Wideband data transmission systems/RFID"
  },
  {
    "f1Mhz": 2450.0,
    "f2Mhz": 2483.5,
    "name": "Fixed/Mobile",
    "applications": "ISM/Non-specific SRDs/Wideband data transmission systems/RFID/Radiodetermination applications/PMSE"
  },
  {
    "f1Mhz": 2483.5,
    "f2Mhz": 2500.0,
    "name": "Fixed/Mobile/Mobile-Satellite (space-to-Earth)",
    "applications": "PMSE/MBANS/Active medical implants/ISM/Land mobile/MSS Earth stations/IMT-2000 satellite component"
  },
  {
    "f1Mhz": 2500.0,
    "f2Mhz": 2520.0,
    "name": "Mobile except aeronautical mobile/Fixed",
    "applications": "MCV/MFCN"
  },
  {
    "f1Mhz": 2520.0,
    "f2Mhz": 2655.0,
    "name": "Fixed/Mobile except aeronautical mobile",
    "applications": "MFCN/MCV"
  },
  {
    "f1Mhz": 2655.0,
    "f2Mhz": 2670.0,
    "name": "Fixed/Mobile except aeronautical mobile/Earth Exploration-Satellite (passive)/Radio Astronomy/Space Research (passive)",
    "applications": "MCV/MFCN/Radio astronomy"
  },
  {
    "f1Mhz": 2670.0,
    "f2Mhz": 2690.0,
    "name": "Mobile except aeronautical mobile/Fixed/Radio Astronomy",
    "applications": "Radio astronomy/MFCN/MCV"
  },
  {
    "f1Mhz": 2690.0,
    "f2Mhz": 2700.0,
    "name": "Earth Exploration-Satellite (passive)/Radio Astronomy/Space Research (passive)",
    "applications": "Passive sensors (satellite)/Radio astronomy"
  },
  {
    "f1Mhz": 2700.0,
    "f2Mhz": 2900.0,
    "name": "Aeronautical Radionavigation/Radiolocation",
    "applications": "Radiolocation (civil)/Aeronautical navigation/Weather radar/Radiolocation (military)/PMSE"
  },
  {
    "f1Mhz": 2900.0,
    "f2Mhz": 3100.0,
    "name": "Radiolocation/Radionavigation",
    "applications": "Radiolocation (military)/Radiolocation (civil)"
  },
  {
    "f1Mhz": 3100.0,
    "f2Mhz": 3300.0,
    "name": "Radiolocation/Earth Exploration-Satellite (active)/Space Research (active)",
    "applications": "Radiolocation (civil)/Active sensors (satellite)/Radiolocation (military)/UWB applications/Radio astronomy"
  },
  {
    "f1Mhz": 3300.0,
    "f2Mhz": 3400.0,
    "name": "Radiolocation",
    "applications": "Radio astronomy/Radiolocation (military)/Radiolocation (civil)/UWB applications"
  },
  {
    "f1Mhz": 3400.0,
    "f2Mhz": 3600.0,
    "name": "Fixed/Fixed-Satellite (space-to-Earth)/Amateur/Radiolocation/Mobile except aeronautical mobile",
    "applications": "Amateur/FSS Earth stations/MFCN/PMSE/Radiolocation (civil)/Radiolocation (military)/UWB applications/BWA"
  },
  {
    "f1Mhz": 3600.0,
    "f2Mhz": 4200.0,
    "name": "Mobile/Fixed/Fixed-Satellite (space-to-Earth)",
    "applications": "-/BWA/FSS Earth stations/Fixed/UWB applications/MFCN/ESV"
  },
  {
    "f1Mhz": 4200.0,
    "f2Mhz": 4400.0,
    "name": "Aeronautical Radionavigation/Aeronautical Mobile (R)",
    "applications": "WAIC/Aeronautical military systems/UWB applications/Altimeters/Passive sensors (satellite)"
  },
  {
    "f1Mhz": 4400.0,
    "f2Mhz": 4500.0,
    "name": "Fixed/Mobile",
    "applications": "PMSE/UWB applications/Aeronautical military systems/Land military systems/Maritime military systems/Telemetry/Telecommand (military)"
  },
  {
    "f1Mhz": 4500.0,
    "f2Mhz": 4800.0,
    "name": "Fixed/Fixed-Satellite (space-to-Earth)/Mobile",
    "applications": "Land military systems/Maritime military systems/Telemetry/Telecommand (military)/Aeronautical military systems/UWB applications/Radiodetermination applications/FSS Earth stations/PMSE"
  },
  {
    "f1Mhz": 4800.0,
    "f2Mhz": 4990.0,
    "name": "Fixed/Radio Astronomy/Mobile",
    "applications": "PMSE/Passive sensors (satellite)/Radio astronomy/Radiodetermination applications/BBDR/Aeronautical military systems/Land military systems/Telemetry/Telecommand (military)/Maritime military systems"
  },
  {
    "f1Mhz": 4990.0,
    "f2Mhz": 5000.0,
    "name": "Fixed/Mobile except aeronautical mobile/Radio Astronomy",
    "applications": "Telemetry/Telecommand (military)/Land military systems/Maritime military systems/Aeronautical military systems/Radiodetermination applications/PMSE/Radio astronomy"
  },
  {
    "f1Mhz": 5000.0,
    "f2Mhz": 5010.0,
    "name": "Aeronautical Radionavigation/Radionavigation-Satellite (Earth-to-space)/Radio Astronomy/Space Research (passive)/Aeronautical Mobile-Satellite (R)",
    "applications": "Radio astronomy/Satellite navigation systems/GALILEO/Radiodetermination applications"
  },
  {
    "f1Mhz": 5010.0,
    "f2Mhz": 5030.0,
    "name": "Aeronautical Mobile-Satellite (R)/Aeronautical Radionavigation/Radionavigation-Satellite (space-to-Earth) (space-to-space)/Radio Astronomy/Space Research (passive)",
    "applications": "Radiodetermination applications/GALILEO/Radio astronomy/Satellite navigation systems"
  },
  {
    "f1Mhz": 5030.0,
    "f2Mhz": 5091.0,
    "name": "Aeronautical Radionavigation/Aeronautical Mobile-Satellite (R)/Aeronautical Mobile (R)",
    "applications": "MLS/Radiodetermination applications"
  },
  {
    "f1Mhz": 5091.0,
    "f2Mhz": 5150.0,
    "name": "Aeronautical Mobile-Satellite (R)/Aeronautical Radionavigation/Fixed-Satellite (Earth-to-space)/Aeronautical Mobile",
    "applications": "Radiodetermination applications/-"
  },
  {
    "f1Mhz": 5150.0,
    "f2Mhz": 5250.0,
    "name": "Aeronautical Radionavigation/Fixed-Satellite (Earth-to-space)/Mobile except aeronautical mobile",
    "applications": "Radiodetermination applications/BBDR/Aeronautical telemetry/Feeder links/Radio LANs"
  },
  {
    "f1Mhz": 5250.0,
    "f2Mhz": 5255.0,
    "name": "Earth Exploration-Satellite (active)/Mobile except aeronautical mobile/Radiolocation/Space Research",
    "applications": "Active sensors (satellite)/Radiodetermination applications/Maritime radar/Weather radar/Radio LANs/-/Radiolocation (military)"
  },
  {
    "f1Mhz": 5255.0,
    "f2Mhz": 5350.0,
    "name": "Earth Exploration-Satellite (active)/Mobile except aeronautical mobile/Radiolocation/Space Research (active)",
    "applications": "Radiolocation (military)/-/Radiodetermination applications/Radio LANs/Active sensors (satellite)/Maritime radar/Weather radar"
  },
  {
    "f1Mhz": 5350.0,
    "f2Mhz": 5460.0,
    "name": "Aeronautical Radionavigation/Earth Exploration-Satellite (active)/Radiolocation/Space Research (active)",
    "applications": "Active sensors (satellite)/Maritime radar/Weather radar/Radiodetermination applications/-/Radiolocation (military)"
  },
  {
    "f1Mhz": 5460.0,
    "f2Mhz": 5470.0,
    "name": "Earth Exploration-Satellite (active)/Radiolocation/Radionavigation/Space Research (active)",
    "applications": "Radiolocation (military)/-/Radiodetermination applications/Active sensors (satellite)/Maritime radar/Weather radar"
  },
  {
    "f1Mhz": 5470.0,
    "f2Mhz": 5570.0,
    "name": "Earth Exploration-Satellite (active)/Maritime Radionavigation/Mobile except aeronautical mobile/Radiolocation/Space Research (active)",
    "applications": "Active sensors (satellite)/-/Maritime radar/Weather radar/Radio LANs/Radiodetermination applications/Radiolocation (military)"
  },
  {
    "f1Mhz": 5570.0,
    "f2Mhz": 5650.0,
    "name": "Maritime Radionavigation/Mobile except aeronautical mobile/Radiolocation",
    "applications": "Radiolocation (military)/Radiodetermination applications/-/Maritime radar/Radio LANs/Weather radar"
  },
  {
    "f1Mhz": 5650.0,
    "f2Mhz": 5725.0,
    "name": "Mobile except aeronautical mobile/Radiolocation/Amateur/Amateur-Satellite (Earth-to-space)",
    "applications": "Amateur/-/Maritime radar/Weather radar/Radio LANs/Radiodetermination applications/Radiolocation (military)/Amateur-satellite"
  },
  {
    "f1Mhz": 5725.0,
    "f2Mhz": 5830.0,
    "name": "Radiolocation/Amateur/Mobile/Fixed-Satellite (Earth-to-space)/Fixed",
    "applications": "WIA/Radiolocation (military)/Radiodetermination applications/BFWA/Amateur/ISM/Non-specific SRDs/TTT/Weather radar"
  },
  {
    "f1Mhz": 5830.0,
    "f2Mhz": 5850.0,
    "name": "Fixed/Fixed-Satellite (Earth-to-space)/Radiolocation/Amateur/Amateur-Satellite (space-to-Earth)/Mobile",
    "applications": "ISM/Non-specific SRDs/Weather radar/Radiodetermination applications/Amateur-satellite/Radiolocation (military)/WIA/Amateur/BFWA"
  },
  {
    "f1Mhz": 5850.0,
    "f2Mhz": 5925.0,
    "name": "Fixed/Mobile/Fixed-Satellite (Earth-to-space)",
    "applications": "MBR/WIA/DA2GC/Radiodetermination applications/BFWA/ITS/FSS Earth stations/ISM/Non-specific SRDs"
  },
  {
    "f1Mhz": 5925.0,
    "f2Mhz": 6700.0,
    "name": "Fixed/Fixed-Satellite (Earth-to-space)/Earth Exploration-Satellite (passive)",
    "applications": "Passive sensors (satellite)/Fixed/FSS Earth stations/Radiodetermination applications/UWB applications/-/ESV/Radio astronomy"
  }
];
