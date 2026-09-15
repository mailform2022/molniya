/**
 * `diff all` of the reference Молния board (MOLNIYAF405WING, INAV 7.1.2, revision 889d6f08) as flown by the project owner.
 * Verbatim from the board, except the 6 `vtxmap …` rules are removed: the VTX channel map is per-user and
 * is produced by the VTX step of the wizard from the selected VTX grid.
 */
export const MOLNIYA_712_PRESET_NAME = 'Молния — INAV 7.1.2 (889d6f08), без VTX Channel Map';
export const MOLNIYA_712_PRESET_VERSION = '7.1.2-889d6f08';
export const MOLNIYA_712_PRESET = String.raw`diff all

# version
# INAV/MOLNIYAF405WING 7.1.2 Sep  9 2026 / 17:51:44 (889d6f08)
# GCC-10.3.1 20210824 (release)

# start the command batch
batch start

# reset configuration to default settings
defaults noreboot

# resources

# Timer overrides

# Outputs [servo]
servo 1 850 2150 1670 -125
servo 2 1000 2000 1500 -110
servo 3 1000 2000 1500 -110
servo 4 1000 2000 1200 100

# safehome

# Fixed Wing Approach

# features
feature MOTOR_STOP
feature PWM_OUTPUT_ENABLE
feature FW_AUTOTRIM

# beeper

# blackbox
blackbox -NAV_ACC
blackbox NAV_POS
blackbox NAV_PID
blackbox MAG
blackbox ACC
blackbox ATTI
blackbox RC_DATA
blackbox RC_COMMAND
blackbox MOTORS
blackbox -GYRO_RAW
blackbox -PEAKS_R
blackbox -PEAKS_P
blackbox -PEAKS_Y

# Receiver: Channel map

# Ports
serial 1 2 115200 115200 0 115200
serial 4 8192 115200 115200 0 115200

# LEDs

# LED color

# LED mode_color

# Modes [aux]
aux 0 0 0 1500 2100
aux 1 1 2 900 1300
aux 2 3 2 1300 1700
aux 3 5 2 1300 1700
aux 4 35 2 1300 1700
aux 5 36 2 900 1300
aux 6 42 3 1700 2100
aux 7 47 0 900 2100
aux 8 48 3 1700 2100
aux 9 57 4 1700 2100
aux 10 58 5 1700 2100

# Adjustments [adjrange]

# Receiver rxrange

# temp_sensor

# Mission Control Waypoints [wp]
#wp 0 invalid

# OSD [osd_layout]
osd_layout 0 0 22 2 V
osd_layout 0 1 2 13 V
osd_layout 0 2 0 0 V
osd_layout 0 3 8 6 V
osd_layout 0 9 1 3 V
osd_layout 0 11 5 11 V
osd_layout 0 12 23 13 V
osd_layout 0 13 13 5 V
osd_layout 0 14 13 3 V
osd_layout 0 15 4 8 V
osd_layout 0 16 2 4 H
osd_layout 0 17 2 5 H
osd_layout 0 24 13 2 V
osd_layout 0 25 23 5 V
osd_layout 0 28 22 2 H
osd_layout 0 30 1 14 V
osd_layout 0 34 11 1 H
osd_layout 0 35 2 12 H
osd_layout 0 109 22 4 V
osd_layout 0 110 22 3 V
osd_layout 1 0 22 2 V
osd_layout 1 1 2 13 V
osd_layout 1 2 0 0 V
osd_layout 1 3 8 6 V
osd_layout 1 7 13 12 V
osd_layout 1 9 1 3 V
osd_layout 1 11 5 11 V
osd_layout 1 12 23 13 V
osd_layout 1 13 13 5 V
osd_layout 1 14 13 3 V
osd_layout 1 15 4 8 V
osd_layout 1 16 2 4 H
osd_layout 1 17 2 5 H
osd_layout 1 24 13 2 V
osd_layout 1 25 23 5 V
osd_layout 1 28 22 2 H
osd_layout 1 30 1 14 V
osd_layout 1 34 11 1 H
osd_layout 1 35 2 12 H
osd_layout 1 109 22 4 V
osd_layout 1 110 22 3 V
osd_layout 1 142 12 3 V

# VTX: RC channel map [vtxmap] — задаётся на шаге «VTX и сетка», в пресете отсутствует

# Programming: logic

# Programming: global variables

# Programming: PID controllers

# OSD: custom elements

# master
set gyro_main_lpf_hz = 25
set dynamic_gyro_notch_q = 250
set dynamic_gyro_notch_min_hz = 30
set gyro_zero_x = -3
set gyro_zero_y = 4
set gyro_zero_z = -1
set ins_gravity_cmss =  990.050
set acc_hardware = LSM6DXX
set acczero_y = -2
set acczero_z = 20
set accgain_x = 4091
set accgain_y = 4093
set accgain_z = 4094
set align_mag = CW0FLIP
set mag_hardware = HMC5883
set magzero_x = -143
set magzero_y = -757
set magzero_z = -298
set maggain_x = 2219
set maggain_y = 1888
set maggain_z = 1568
set baro_hardware = SPL06
set rc_filter_auto = OFF
set max_throttle = 2000
set motor_pwm_protocol = STANDARD
set failsafe_procedure = NONE
set align_board_yaw = 1800
set current_meter_scale = 500
set current_meter_type = VIRTUAL
set small_angle = 180
set disarm_kill_switch = OFF
set applied_defaults = 3
set gps_sbas_mode = AUTO
set gps_ublox_use_galileo = ON
set gps_ublox_use_beidou = ON
set gps_ublox_use_glonass = ON
set deadband = 32
set airmode_type = STICK_CENTER_ONCE
set inav_w_z_baro_p =  0.350
set nav_extra_arming_safety = ON
set nav_wp_radius = 5000
set nav_wp_max_safe_distance = 500
set nav_rth_allow_landing = FS_ONLY
set nav_rth_altitude = 5000
set nav_fw_climb_angle = 12
set nav_fw_control_smoothness = 2
set nav_fw_launch_motor_delay = 1
set nav_fw_launch_spinup_time = 250
set nav_fw_launch_end_time = 5000
set nav_fw_launch_timeout = 50000
set nav_fw_launch_max_altitude = 5000
set nav_fw_launch_climb_angle = 15
set pilot_name = FIRE!!!
set vtx_3g3_grid = TX3339
set vtx_band = 2
set vtx_channel = 8
set vtx_power = 3
set pinio_box3 = 57

# mixer_profile
mixer_profile 1

set platform_type = AIRPLANE
set has_flaps = ON
set model_preview_type = 26

# Mixer: motor mixer

mmix reset

mmix 0  1.000  0.000  0.000 -0.500
mmix 1  1.000  0.000  0.000  0.500

# Mixer: servo mixer
smix reset

smix 0 1 1 100 0 -1
smix 1 2 0 100 0 -1
smix 2 3 0 100 0 -1
smix 3 4 11 100 0 -1
smix 4 5 16 100 0 -1

# mixer_profile
mixer_profile 2


# Mixer: motor mixer

# Mixer: servo mixer

# profile
profile 1

set fw_p_pitch = 15
set fw_i_pitch = 5
set fw_d_pitch = 5
set fw_ff_pitch = 80
set fw_p_roll = 15
set fw_i_roll = 3
set max_angle_inclination_rll = 450
set dterm_lpf_hz = 10
set fw_turn_assist_yaw_gain =  2.000
set fw_turn_assist_pitch_gain =  0.600
set nav_fw_pos_z_p = 25
set nav_fw_pos_z_d = 8
set nav_fw_pos_xy_p = 55
set d_boost_min =  1.000
set d_boost_max =  1.000
set rc_expo = 30
set rc_yaw_expo = 30
set roll_rate = 18
set pitch_rate = 9
set yaw_rate = 3

# profile
profile 2


# profile
profile 3


# battery_profile
battery_profile 1

set bat_cells = 6
set vbat_cell_detect_voltage = 435
set vbat_max_cell_voltage = 430
set throttle_idle =  5.000
set nav_mc_hover_thr = 1600
set nav_fw_cruise_thr = 1650
set nav_fw_min_thr = 1550
set nav_fw_max_thr = 1800
set nav_fw_pitch2thr = 6
set nav_fw_launch_thr = 2000
set nav_fw_launch_idle_thr = 1750
set limit_cont_current = 2000
set limit_burst_current = 2000
set limit_burst_current_time = 2000
set limit_burst_current_falldown_time = 3000

# battery_profile
battery_profile 2


# battery_profile
battery_profile 3


# restore original profile selection
mixer_profile 1
profile 1
battery_profile 1

# save configuration
save

# 
`;
