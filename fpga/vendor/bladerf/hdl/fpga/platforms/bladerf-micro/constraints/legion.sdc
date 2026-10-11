# LEGION CDC: tx/adi ctrl_tx → nios wcur_meta (2FF).
set_false_path -from *ctrl_tx* -to *wcur_meta*
set_false_path -from *ctrl_tx* -to *st_meta*
# ctrl_tx = 2FF r_ctrl (PIO). Не walk, не каждый клок.
# Конус: MODE → lg_mode_lb → dly0_sel → delay=0 mux → din → mix → q.
set_multicycle_path -setup 4 -from *ctrl_tx* -to *legion_lb_aim*q*
set_multicycle_path -hold 3 -from *ctrl_tx* -to *legion_lb_aim*q*
set_false_path -from [get_clocks {U_system_pll|altera_pll_i|general[0].gpll~PLL_OUTPUT_COUNTER|divclk}] -to [get_clocks {U_nios_system|axi_ad9361_0|i_dev_if|i_rx|i_altlvds_rx|auto_generated|pll_sclk~PLL_OUTPUT_COUNTER|divclk}]
set_false_path -from [get_clocks {U_nios_system|axi_ad9361_0|i_dev_if|i_rx|i_altlvds_rx|auto_generated|pll_sclk~PLL_OUTPUT_COUNTER|divclk}] -to [get_clocks {U_system_pll|altera_pll_i|general[0].gpll~PLL_OUTPUT_COUNTER|divclk}]
